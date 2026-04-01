import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { getSettings } from '../config';

const queueInstances = new Map<string, Queue>();

export function buildQueueName(providerName: string): string {
  const prefix = process.env.BULLMQ_QUEUE_PREFIX ?? 'webhooks';
  return `${prefix}-${providerName}`;
}

export function getProviderQueue(providerName: string): Queue {
  const existing = queueInstances.get(providerName);
  if (existing) {
    return existing;
  }

  const settings = getSettings();
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(buildQueueName(providerName), {
    connection,
  });

  queueInstances.set(providerName, queue);
  return queue;
}

export function resetQueues(): void {
  queueInstances.clear();
}
