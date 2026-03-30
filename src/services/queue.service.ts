import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { getSettings } from '../config';

const queueInstances = new Map<string, Queue>();

function buildQueueName(providerName: string): string {
  return `webhooks-${providerName}`;
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
