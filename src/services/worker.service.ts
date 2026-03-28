import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import type { ProviderConfig } from '../config';
import { getSettings } from '../config';
import { getLogger } from '../lib/logging';

const logger = getLogger('worker');

function buildQueueName(providerName: string): string {
  return `webhooks-${providerName}`;
}

export async function processJob(job: Job<string>, provider: ProviderConfig): Promise<void> {
  const settings = getSettings();
  logger.info({ jobId: job.id, provider: provider.name }, 'Processing webhook job');

  const envelope = JSON.stringify({ message: job.data });

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

  logger.info(
    { jobId: job.id, provider: provider.name, status: response.status },
    'Webhook delivered to gateway',
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
