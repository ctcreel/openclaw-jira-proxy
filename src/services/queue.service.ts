import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { getSettings } from '../config';

const QUEUE_NAME = 'jira-webhooks';

let queueInstance: Queue | null = null;

export function getQueue(): Queue {
  if (queueInstance !== null) {
    return queueInstance;
  }

  const settings = getSettings();
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });

  queueInstance = new Queue(QUEUE_NAME, { connection });
  return queueInstance;
}

export function resetQueue(): void {
  queueInstance = null;
}
