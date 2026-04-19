import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Worker, Queue } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';
import { createHash } from 'node:crypto';

import type { ProviderConfig, ModelRule } from '../config';
import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import { renderTemplate } from '../lib/template/template-engine';
import { extractWebhookContext } from '../strategies/context';
import { resolveAgentFromAgents, resolveFieldPath } from '../strategies/routing';
import type { ResolvedAgent } from './agent-loader.service';
import type { AlertRegistry } from './alerts';
import type { JobAlert } from './alerts';
import { getEventBus } from './event-bus.service';
import { getRunner } from '../runners/registry';
import { buildQueueName } from './queue.service';

const logger = getLogger('worker');

export interface JobEnvelope {
  payload: string;
  attempt: number;
  originalJobId?: string;
}

/** Parse raw job data into an envelope. Re-enqueued jobs already have the envelope shape. */
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
  agents: readonly ResolvedAgent[],
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

  // HMAC validation already succeeded in the controller, so the payload
  // is trusted. A JSON parse failure here is a real bug — let it throw
  // and surface via the worker's failure path rather than silently
  // routing an empty object.
  const parsedPayload: unknown = JSON.parse(envelope.payload);

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

  const resolved = resolveAgentFromAgents(parsedPayload, provider.name, agents);
  if (resolved === null) {
    logger.warn(
      { jobId: job.id, provider: provider.name },
      'routing:no-match — skipping forwarding',
    );
    return;
  }
  const { agentId, agentDir, messageTemplate: templatePath } = resolved;

  logger.info(
    { jobId: job.id, provider: provider.name, template: templatePath, agentId },
    'Routing matched',
  );

  const jobIdString = String(job.id ?? 'unknown');
  const traceId = envelope.originalJobId ?? jobIdString;
  const events = getEventBus();
  const matchedAgent = agents.find((agent) => agent.name === agentId);
  if (!matchedAgent) {
    throw new Error(`Routing resolved agentId "${agentId}" but that agent is not loaded`);
  }
  const modelRules = matchedAgent.config.modelRules[provider.name];
  const selectedModel = resolveModel(parsedPayload, modelRules);

  if (selectedModel) {
    logger.info(
      { jobId: job.id, provider: provider.name, model: selectedModel },
      'Model selected by routing rule',
    );
  }

  let prompt: string;
  if (templatePath) {
    const templateContent = await readFile(join(agentDir, templatePath), 'utf-8');
    prompt = await renderTemplate(templateContent, parsedPayload, agentDir);
  } else {
    prompt = envelope.payload;
  }

  const sessionKey = `agent:${agentId}:hook-${provider.name}-${traceId}`;
  const runnerName = provider.runner?.type ?? 'openclaw';
  const runner = getRunner(runnerName);

  // Prompt observability: hash at info level, full prompt at debug level
  const promptHash = createHash('sha256').update(prompt).digest('hex').slice(0, 12);
  logger.info(
    {
      jobId: job.id,
      provider: provider.name,
      runner: runnerName,
      sessionKey,
      promptHash,
      promptLength: prompt.length,
    },
    'Agent run delivered',
  );
  logger.debug(
    {
      jobId: job.id,
      provider: provider.name,
      runner: runnerName,
      sessionKey,
      prompt,
    },
    'Agent run prompt',
  );

  const jobStartedAt = Date.now();
  events.publish({
    type: 'job.started',
    timestamp: jobStartedAt,
    traceId,
    jobId: jobIdString,
    provider: provider.name,
    agentId,
    template: templatePath,
    runner: runnerName,
    model: selectedModel,
  });

  const result = await runner.run({
    prompt,
    sessionKey,
    agentId,
    model: selectedModel,
    timeoutMs: settings.agentWaitTimeoutMs,
    traceId,
    jobId: jobIdString,
  });

  if (result.status === 'error') {
    throw new Error(`Agent run failed: ${result.error ?? 'unknown error'}`);
  }

  if (result.status === 'timeout') {
    throw new Error(`Agent run timed out (runId: ${result.runId})`);
  }

  // Dedup key intentionally NOT cleared here — let it expire naturally per
  // dedupTtlSeconds. Clearing it on completion lets Jira's webhook fan-out
  // (e.g. comment-added events that fire with the issue's prior status
  // snapshot ~1-2s after a transition) re-trigger Patch on the same
  // ticket+status, which costs a wasted Claude run. To re-trigger
  // intentionally, transition the ticket out of and back into the status
  // — the new event is past the dedup window.

  events.publish({
    type: 'job.completed',
    timestamp: Date.now(),
    traceId,
    jobId: jobIdString,
    provider: provider.name,
    durationMs: Date.now() - jobStartedAt,
    runId: result.runId ?? 'unknown',
  });

  logger.info(
    { jobId: job.id, provider: provider.name, sessionKey, runId: result.runId },
    'Agent run completed — job complete',
  );
}

export interface CreateWorkerOptions {
  provider: ProviderConfig;
  agents: readonly ResolvedAgent[];
  alertRegistry?: AlertRegistry;
}

export function createWorker(options: CreateWorkerOptions): Worker<string> {
  const { provider, agents, alertRegistry } = options;

  const settings = getSettings();
  const redisUrl = settings.redisUrl;
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const maxAttempts = settings.jobMaxAttempts;

  const worker = new Worker<string>(
    buildQueueName(provider.name),
    (job) => processJob(job, provider, agents),
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
    const traceId = envelope.originalJobId ?? String(job.id ?? 'unknown');
    const jobIdString = String(job.id ?? 'unknown');

    getEventBus().publish({
      type: 'job.failed',
      timestamp: Date.now(),
      traceId,
      jobId: jobIdString,
      provider: provider.name,
      error: error.message,
      attempt: envelope.attempt,
      final: isFinalFailure,
    });

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
        const alert: JobAlert = {
          jobId: traceId,
          sessionKey: `agent:unknown:main`,
          agentId: 'unknown',
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

      // Re-enqueue to the back with exponential delay — give runner time to recover
      const delayMs = Math.min(5_000 * Math.pow(2, envelope.attempt - 1), 60_000);
      const retryConn = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      const queue = new Queue(buildQueueName(provider.name), { connection: retryConn });
      queue
        .add('webhook-event', JSON.stringify(retryEnvelope), { delay: delayMs })
        .then((requeued) => {
          logger.info(
            {
              jobId: job.id,
              provider: provider.name,
              newAttempt: retryEnvelope.attempt,
              originalJobId: retryEnvelope.originalJobId,
            },
            'Job re-enqueued to back of queue',
          );
          getEventBus().publish({
            type: 'job.requeued',
            timestamp: Date.now(),
            traceId,
            jobId: String(requeued.id ?? 'unknown'),
            provider: provider.name,
            attempt: retryEnvelope.attempt,
            originalJobId: String(retryEnvelope.originalJobId ?? jobIdString),
          });
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
