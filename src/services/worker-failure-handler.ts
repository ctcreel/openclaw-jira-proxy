import type { Job, Queue } from 'bullmq';

import type { ProviderConfig } from '../config';
import { getLogger } from '../lib/logging';
import type { AlertRegistry, JobAlert } from './alerts';
import { getDedupRedis } from './dedup.service';
import { getEventBus } from './event-bus.service';
import { buildInflightKey, parseInflightHash } from './inflight-registry.service';
import type { InflightRecord } from './inflight-registry.service';
import { parseEnvelope } from './worker.service';
import type { JobEnvelope } from './worker.service';

const logger = getLogger('worker-failure');

/** Exponential backoff, capped at 60s. First retry ~5s, second ~10s, etc. */
function computeRequeueDelayMs(attempt: number): number {
  return Math.min(5_000 * Math.pow(2, attempt - 1), 60_000);
}

async function readInflightRecord(traceId: string): Promise<InflightRecord | null> {
  try {
    const raw = await getDedupRedis().hgetall(buildInflightKey(traceId));
    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }
    return parseInflightHash(raw);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), traceId },
      'worker-failure:inflight-lookup-failed',
    );
    return null;
  }
}

async function emitFinalFailureAlert(
  alertRegistry: AlertRegistry,
  provider: ProviderConfig,
  traceId: string,
  envelope: JobEnvelope,
  errorMessage: string,
  maxAttempts: number,
  inflight: InflightRecord | null,
): Promise<void> {
  const agentId = inflight?.agentId ?? 'unknown';
  const sessionKey = `agent:${agentId}:hook-${provider.name}-${traceId}`;
  const alert: JobAlert = {
    jobId: traceId,
    sessionKey,
    agentId,
    error: errorMessage,
    attempts: envelope.attempt,
    maxAttempts,
    provider: provider.name,
    failedAt: new Date(),
    kind: 'final-failure',
    ...(inflight?.contextId !== undefined ? { contextId: inflight.contextId } : {}),
    ...(inflight?.contextTitle !== undefined ? { contextTitle: inflight.contextTitle } : {}),
    ...(inflight?.contextStatus !== undefined ? { contextStatus: inflight.contextStatus } : {}),
  };

  await alertRegistry.sendAll(alert);
}

async function requeueJobToBack(
  requeueQueue: Queue,
  provider: ProviderConfig,
  job: Job<string>,
  envelope: JobEnvelope,
  traceId: string,
  jobIdString: string,
): Promise<void> {
  const retryEnvelope: JobEnvelope = {
    payload: envelope.payload,
    attempt: envelope.attempt + 1,
    originalJobId: envelope.originalJobId ?? job.id ?? undefined,
    // Preserve context across retries so the recovery emit in
    // worker.processJob still fires after a restart-during-retry.
    ...(envelope.context === undefined ? {} : { context: envelope.context }),
  };
  const delayMs = computeRequeueDelayMs(envelope.attempt);

  const requeued = await requeueQueue.add('webhook-event', JSON.stringify(retryEnvelope), {
    delay: delayMs,
  });

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
}

async function handleFailure(
  provider: ProviderConfig,
  requeueQueue: Queue,
  alertRegistry: AlertRegistry | undefined,
  maxAttempts: number,
  job: Job<string>,
  error: Error,
): Promise<void> {
  const envelope = parseEnvelope(job.data);
  const isFinalFailure = envelope.attempt >= maxAttempts;
  const traceId = envelope.originalJobId ?? String(job.id ?? 'unknown');
  const jobIdString = String(job.id ?? 'unknown');

  // Snapshot the inflight record before publishing `job.failed` — the
  // InflightRegistry subscriber DELs the key on `final=true`, and we need
  // the agentId / contextId fields to enrich the alert. Skipping the
  // lookup on retries keeps the hot path lean.
  const inflight = isFinalFailure ? await readInflightRecord(traceId) : null;

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
    logger.error(
      {
        jobId: job.id,
        provider: provider.name,
        error: error.message,
        attempt: envelope.attempt,
        maxAttempts,
        agentId: inflight?.agentId ?? 'unknown',
        contextId: inflight?.contextId,
      },
      'Job permanently failed — all retries exhausted',
    );
    if (alertRegistry) {
      await emitFinalFailureAlert(
        alertRegistry,
        provider,
        traceId,
        envelope,
        error.message,
        maxAttempts,
        inflight,
      );
    }
    return;
  }

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

  await requeueJobToBack(requeueQueue, provider, job, envelope, traceId, jobIdString);
}

/**
 * Builds the BullMQ `failed` event handler for a provider's worker. The
 * returned handler is a plain callback — it decides whether a failure is
 * final (all retries exhausted) or transient, and routes to either the
 * alert registry or the requeue queue accordingly.
 *
 * The requeue queue must be long-lived and share the worker's Redis
 * connection. Creating new queues/connections per failure leaks sockets
 * under sustained error conditions.
 */
export function buildFailedHandler(
  provider: ProviderConfig,
  requeueQueue: Queue,
  alertRegistry: AlertRegistry | undefined,
  maxAttempts: number,
): (job: Job<string> | undefined, error: Error) => void {
  return (job, error) => {
    if (!job) return;
    handleFailure(provider, requeueQueue, alertRegistry, maxAttempts, job, error).catch((err) => {
      logger.error(
        { error: err instanceof Error ? err.message : String(err), jobId: job.id },
        'worker-failure:handler-fault',
      );
    });
  };
}
