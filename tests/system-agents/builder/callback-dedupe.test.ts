import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type IORedis from 'ioredis';

import {
  clearCallbackEvent,
  saveCallbackEvent,
} from '../../../src/system-agents/builder/callback-dedupe';

describe('callback dedupe', () => {
  let redis: IORedis;

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
  });

  it('returns true on the first delivery of an event_id', async () => {
    const first = await saveCallbackEvent('job-1:testable', redis);
    expect(first).toBe(true);
  });

  it('returns false on subsequent deliveries of the same event_id', async () => {
    await saveCallbackEvent('job-1:testable', redis);
    const second = await saveCallbackEvent('job-1:testable', redis);
    expect(second).toBe(false);
  });

  it('distinguishes between event_ids that share a job_id', async () => {
    expect(await saveCallbackEvent('job-1:working', redis)).toBe(true);
    expect(await saveCallbackEvent('job-1:question_pending', redis)).toBe(true);
    expect(await saveCallbackEvent('job-1:working', redis)).toBe(false);
  });

  it('distinguishes between event_ids that share a state', async () => {
    expect(await saveCallbackEvent('job-1:testable', redis)).toBe(true);
    expect(await saveCallbackEvent('job-2:testable', redis)).toBe(true);
  });

  it('records the key with a TTL so memory is bounded', async () => {
    await saveCallbackEvent('job-1:testable', redis);
    const ttl = await redis.ttl('builder:callback:event:job-1:testable');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it('clearCallbackEvent makes the next delivery first-again', async () => {
    await saveCallbackEvent('job-1:testable', redis);
    await clearCallbackEvent('job-1:testable', redis);
    expect(await saveCallbackEvent('job-1:testable', redis)).toBe(true);
  });
});
