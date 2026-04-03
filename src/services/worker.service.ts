import { Worker, Queue } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import type { ProviderConfig, ModelRule } from '../config';
import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import { renderTemplate } from '../lib/template/template-engine';
import { extractWebhookContext } from '../strategies/context';
import { getDedupRedis } from './dedup.service';
import { resolveAgent, resolveFieldPath } from '../strategies/routing';
import type { AlertRegistry } from './alerts';
import type { JobAlert } from './alerts';
import type { GatewayClient } from './gateway-client';
import { buildQueueName } from './queue.service';

const logger = getLogger('worker');

/**
 * Job data envelope. The webhook payload is wrapped with attempt metadata
 * so we can track retries without relying on BullMQ's built-in attempts
 * (which hold the failed job at the front of the queue).
 */
export interface JobEnvelope {
  /** Original webhook body (stringified JSON). */
  payload: string;
  /** Current attempt number (1-indexed). */
  attempt: number;
  /** Original job ID for traceability across re-enqueues. */
  originalJobId?: string;
}

/**
 * Wrap a raw payload string into a JobEnvelope for first attempt.
 * If the data is already an envelope (from a re-enqueue), return as-is.
 */
export function parseEnvelope(data: string): JobEnvelope {
  try {
    const parsed = JSON.parse(data);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'payload' in parsed &&
      'attempt' in parsed
    ) {
      return parsed as JobEnvelope;
    }
  } catch {
    // Not JSON or not an envelope — treat as raw payload
  }
  return { payload: data, attempt: 1 };
}

/**
 * Evaluate model rules against a parsed payload. Returns the model string
 * from the first matching rule, or undefined if no rules match.
 *
 * Example Jira model rules (configured via PROVIDERS_CONFIG):
 *   - field: "changelog.items[*].field", matches: "status",
 *     combined with field: "issue.fields.status.name",
 *     matches: ["Plan", "Ready for Development"] → "anthropic/claude-opus-4-6"
 *   - All other events → "anthropic/claude-sonnet-4-6"
 */
export function resolveModel(
  payload: unknown,
  rules: ReadonlyArray<ModelRule> | undefined,
): string | undefined {
  if (!rules || rules.length === 0) {
    return undefined;
  }

  for (const rule of rules) {
    const value = resolveFieldPath(payload, rule.field);
    if (value === undefined) {
      continue;
    }

    const matchTargets = Array.isArray(rule.matches) ? rule.matches : [rule.matches];
    const fieldValues = Array.isArray(value) ? value : [value];

    const matched = fieldValues.some(
      (fieldValue) => typeof fieldValue === 'string' && matchTargets.includes(fieldValue),
    );

    if (matched) {
      return rule.model;
    }
  }

  return undefined;
}

export async function processJob(
  job: Job<string>,
  provider: ProviderConfig,
  gatewayClient: GatewayClient,
): Promise<void> {
  const settings = getSettings();
  const envelope = parseEnvelope(job.data);

  logger.info(
    {
      jobId: job.id,
      provider: provider.name,
      attempt: envelope.attempt,
      maxAttempts: settings.jobMaxAttempts,
    },
    'Processing webhook job',
  );

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(envelope.payload);
  } catch {
    parsedPayload = {};
  }

  const webhookContext = extractWebhookContext(provider.name, parsedPayload);
  logger.info(
    {
      jobId: job.id,
      provider: provider.name,
      contextId: webhookContext.id,
      contextTitle: webhookContext.title,
      contextStatus: webhookContext.status,
      contextSource: webhookContext.source,
    },
    'Webhook context',
  );

  const resolved = resolveAgent(parsedPayload, provider.routing, settings.openclawAgentId);
  if (resolved === null) {
    logger.warn(
      { jobId: job.id, provider: provider.name },
      'routing:no-match — skipping forwarding',
    );
    return;
  }
  const { agentId, messageTemplate: ruleTemplate } = resolved;

  // Extract template filename for logging
  const templateMatch = ruleTemplate?.match(/jira-[^.]+\.md/);
  const templateName = templateMatch ? templateMatch[0] : (ruleTemplate ?? 'default');

  logger.info(
    { jobId: job.id, provider: provider.name, template: templateName, agentId },
    'Routing matched',
  );

  const traceId = envelope.originalJobId ?? job.id ?? 'unknown';
  const selectedModel = resolveModel(parsedPayload, provider.modelRules);

  if (selectedModel) {
    logger.info(
      { jobId: job.id, provider: provider.name, model: selectedModel },
      'Model selected by routing rule',
    );
  }

  const template = ruleTemplate ?? provider.messageTemplate;
  const message = template ? await renderTemplate(template, parsedPayload) : envelope.payload;

  const sessionKey = `agent:${agentId}:hook-${provider.name}-${traceId}`;

  logger.info(
    { jobId: job.id, provider: provider.name, sessionKey, agentId, traceId },
    'Delivering prompt via agent RPC with completion wait',
  );

  const result = await gatewayClient.runAndWait(
    {
      message,
      sessionKey,
      agentId,
      // Note: model overrides not authorized for external callers.
      // Patch's agent config handles model selection (Opus primary → Sonnet → Haiku).
    },
    settings.agentWaitTimeoutMs,
  );

  if (result.status === 'error') {
    throw new Error(`Agent run failed: ${result.error ?? 'unknown error'}`);
  }

  if (result.status === 'timeout') {
    throw new Error(`Agent run timed out (runId: ${result.runId})`);
  }

  // Clear dedup key so the same ticket+status can be re-triggered if needed
  if (webhookContext.id !== '?') {
    const dedupKey = `clawndom:dedup:${provider.name}:${webhookContext.id}:${webhookContext.status}`;
    await getDedupRedis().del(dedupKey);
  }

  logger.info(
    { jobId: job.id, provider: provider.name, sessionKey, runId: result.runId },
    'Agent run completed — job complete',
  );
}

export interface CreateWorkerOptions {
  provider: ProviderConfig;
  gatewayClient: GatewayClient;
  alertRegistry?: AlertRegistry;
}

export function createWorker(options: CreateWorkerOptions): Worker<string> {
  const { provider, gatewayClient, alertRegistry } = options;

  const settings = getSettings();
  const redisUrl = settings.redisUrl;
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const maxAttempts = settings.jobMaxAttempts;

  const worker = new Worker<string>(
    buildQueueName(provider.name),
    (job) => processJob(job, provider, gatewayClient),
    {
      connection,
      concurrency: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );

  worker.on('failed', (job, error) => {
    if (!job) return;

    const envelope = parseEnvelope(job.data);
    const isFinalFailure = envelope.attempt >= maxAttempts;

    if (isFinalFailure) {
      // Summarily executed in front of the other jobs so they will learn.
      logger.error(
        {
          jobId: job.id,
          provider: provider.name,
          error: error.message,
          attempt: envelope.attempt,
          maxAttempts,
        },
        'Job permanently failed — all retries exhausted',
      );

      if (alertRegistry) {
        const traceId = envelope.originalJobId ?? job.id ?? 'unknown';
        const alert: JobAlert = {
          jobId: traceId,
          sessionKey: `agent:${settings.openclawAgentId}:main`,
          agentId: settings.openclawAgentId,
          error: error.message,
          attempts: envelope.attempt,
          maxAttempts,
          provider: provider.name,
          failedAt: new Date(),
        };

        alertRegistry.sendAll(alert).catch((err) => {
          logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'Alert dispatch failed',
          );
        });
      }
    } else {
      // Bad job! Back to the end of the line.
      logger.warn(
        {
          jobId: job.id,
          provider: provider.name,
          error: error.message,
          attempt: envelope.attempt,
          maxAttempts,
          action: 'requeue-to-back',
        },
        'Job failed — re-enqueueing to back of queue',
      );

      const retryEnvelope: JobEnvelope = {
        payload: envelope.payload,
        attempt: envelope.attempt + 1,
        originalJobId: envelope.originalJobId ?? job.id ?? undefined,
      };

      // Re-enqueue to the back with exponential delay — give gateway time to reconnect
      const delayMs = Math.min(5_000 * Math.pow(2, envelope.attempt - 1), 60_000);
      const retryConn = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      const queue = new Queue(buildQueueName(provider.name), { connection: retryConn });
      queue
        .add('webhook-event', JSON.stringify(retryEnvelope), { delay: delayMs })
        .then(() => {
          logger.info(
            {
              jobId: job.id,
              provider: provider.name,
              newAttempt: retryEnvelope.attempt,
              originalJobId: retryEnvelope.originalJobId,
            },
            'Job re-enqueued to back of queue',
          );
        })
        .catch((err) => {
          logger.error(
            { error: err instanceof Error ? err.message : String(err), jobId: job.id },
            'Failed to re-enqueue job — job is lost',
          );
        })
        .finally(() => {
          queue.close().catch(() => {});
          retryConn.quit().catch(() => {});
        });
    }
  });

  logger.info(
    { provider: provider.name, queue: buildQueueName(provider.name), maxAttempts },
    'Worker started',
  );
  return worker;
}
