import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import { getSettings } from '../config';
import { getLogger } from '../lib/logging';

const QUEUE_NAME = 'jira-webhooks';

const logger = getLogger('worker');

export async function processJob(job: Job<string>): Promise<void> {
  const settings = getSettings();
  logger.info({ jobId: job.id }, 'Processing webhook job');

  const response = await fetch(settings.openclawHookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.openclawToken}`,
    },
    body: job.data,
  });

  if (!response.ok) {
    throw new Error(`OpenClaw returned ${response.status}: ${await response.text()}`);
  }

  logger.info({ jobId: job.id }, 'Webhook delivered');
}

export function createWorker(): Worker<string> {
  const settings = getSettings();
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<string>(QUEUE_NAME, processJob, {
    connection,
    concurrency: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error: error.message }, 'Job failed');
  });

  return worker;
}
