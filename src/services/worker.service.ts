import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import type { ProviderConfig } from '../config';
import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import { resolveAgent } from '../strategies/routing';
import { waitForSessionIdle } from './session-monitor.service';

const logger = getLogger('worker');

function buildQueueName(providerName: string): string {
  return `webhooks-${providerName}`;
}

export async function processJob(
  job: Job<string>,
  provider: ProviderConfig,
  signal?: AbortSignal,
): Promise<void> {
  const settings = getSettings();
  logger.info({ jobId: job.id, provider: provider.name }, 'Processing webhook job');

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(job.data);
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

  const sessionKey = `hook:${provider.name}:${job.id ?? 'unknown'}`;
  const envelope = JSON.stringify({
    message: job.data,
    agentId,
    sessionKey,
    deliver: false,
  });

  const response = await fetch(settings.openclawHookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openclawToken}`,
    },
    body: envelope,
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

export function createWorker(provider: ProviderConfig): Worker<string> {
  const settings = getSettings();
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });

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
    logger.error({ jobId: job?.id, provider: provider.name, error: error.message }, 'Job failed');
  });

  logger.info({ provider: provider.name, queue: buildQueueName(provider.name) }, 'Worker started');
  return worker;
}
