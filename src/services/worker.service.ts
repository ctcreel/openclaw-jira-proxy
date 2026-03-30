import { Worker, Queue } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import type { ProviderConfig, ModelRule } from '../config';
import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import { resolveAgent, resolveFieldPath } from '../strategies/routing';
import type { AlertRegistry } from './alerts';
import type { JobAlert } from './alerts';
import { waitForSessionIdle } from './session-monitor.service';

const logger = getLogger('worker');

function buildQueueName(providerName: string): string {
  return `webhooks-${providerName}`;
}

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
  signal?: AbortSignal,
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

  const agentId = resolveAgent(parsedPayload, provider.routing, settings.openclawAgentId);
  if (agentId === null) {
    logger.warn(
      { jobId: job.id, provider: provider.name },
      'routing:no-match — skipping forwarding',
    );
    return;
  }

  const traceId = envelope.originalJobId ?? job.id ?? 'unknown';
  const sessionKey = `hook:${provider.name}:${traceId}`;
  const selectedModel = resolveModel(parsedPayload, provider.modelRules);

  if (selectedModel) {
    logger.info(
      { jobId: job.id, provider: provider.name, model: selectedModel },
      'Model selected by routing rule',
    );
  }

  const gatewayEnvelope = JSON.stringify({
    message: envelope.payload,
    agentId,
    sessionKey,
    deliver: false,
    ...(selectedModel ? { model: selectedModel } : {}),
  });

  const response = await fetch(settings.openclawHookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openclawToken}`,
    },
    body: gatewayEnvelope,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gateway returned ${response.status}: ${body}`);
  }

  const result = (await response.json()) as { runId?: string };
  const fileSessionKey = `agent:${agentId}:${sessionKey}`;

  logger.info(
    { jobId: job.id, provider: provider.name, runId: result.runId, fileSessionKey },
    'Webhook delivered — waiting for session idle',
  );

  await waitForSessionIdle({
    sessionsFilePath: settings.sessionsFilePath,
    sessionKey: fileSessionKey,
    timeoutMs: settings.agentWaitTimeoutMs,
    signal,
  });

  logger.info(
    { jobId: job.id, provider: provider.name, runId: result.runId },
    'Session idle — job complete',
  );
}

export interface CreateWorkerOptions {
  provider: ProviderConfig;
  alertRegistry?: AlertRegistry;
}

export function createWorker(options: CreateWorkerOptions): Worker<string>;
export function createWorker(provider: ProviderConfig): Worker<string>;
export function createWorker(
  providerOrOptions: ProviderConfig | CreateWorkerOptions,
): Worker<string> {
  const isOptions = (v: unknown): v is CreateWorkerOptions =>
    typeof v === 'object' && v !== null && 'provider' in v;

  const provider = isOptions(providerOrOptions) ? providerOrOptions.provider : providerOrOptions;
  const alertRegistry = isOptions(providerOrOptions) ? providerOrOptions.alertRegistry : undefined;

  const settings = getSettings();
  const redisUrl = settings.redisUrl;
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const maxAttempts = settings.jobMaxAttempts;

  const worker = new Worker<string>(
    buildQueueName(provider.name),
    (job) => processJob(job, provider),
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
          sessionKey: `hook:${provider.name}:${traceId}`,
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

      // Re-enqueue to the back — other waiting jobs go first
      const retryConn = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      const queue = new Queue(buildQueueName(provider.name), { connection: retryConn });
      queue
        .add('webhook-event', JSON.stringify(retryEnvelope))
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
