import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type IORedis from 'ioredis';

const dedupRedisMock = {
  hgetall: vi.fn().mockResolvedValue({}),
  hset: vi.fn().mockResolvedValue(0),
  expire: vi.fn().mockResolvedValue(1),
  del: vi.fn().mockResolvedValue(0),
  exists: vi.fn().mockResolvedValue(0),
};

vi.mock('../../src/services/dedup.service', () => ({
  getDedupRedis: (): typeof dedupRedisMock => dedupRedisMock,
}));

import {
  InflightRegistry,
  buildInflightKey,
  getInflightRegistry,
  parseInflightHash,
  resetInflightRegistry,
} from '../../src/services/inflight-registry.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import type {
  ClawndomEvent,
  JobCompletedEvent,
  JobFailedEvent,
  JobStartedEvent,
  RunnerAssistantTextEvent,
  WebhookAcceptedEvent,
} from '../../src/types/clawndom-event';

interface FakeRedisLog {
  hset: Array<{ key: string; data: Record<string, string> }>;
  hgetall: Array<string>;
  expire: Array<{ key: string; seconds: number }>;
  del: Array<string>;
  exists: Array<string>;
}

interface FakeRedis {
  redis: IORedis;
  log: FakeRedisLog;
  store: Map<string, Record<string, string>>;
  ttls: Map<string, number>;
  /** Manually seed a hash (used to set up test fixtures). */
  seed(key: string, hash: Record<string, string>): void;
}

function createFakeRedis(): FakeRedis {
  const store = new Map<string, Record<string, string>>();
  const ttls = new Map<string, number>();
  const log: FakeRedisLog = { hset: [], hgetall: [], expire: [], del: [], exists: [] };

  const api = {
    hset: async (key: string, data: Record<string, string>): Promise<number> => {
      log.hset.push({ key, data: { ...data } });
      const existing = store.get(key) ?? {};
      const merged = { ...existing, ...data };
      const newFields = Object.keys(data).filter((k) => !(k in existing));
      store.set(key, merged);
      return newFields.length;
    },
    hgetall: async (key: string): Promise<Record<string, string>> => {
      log.hgetall.push(key);
      return store.get(key) ?? {};
    },
    expire: async (key: string, seconds: number): Promise<number> => {
      log.expire.push({ key, seconds });
      ttls.set(key, seconds);
      return store.has(key) ? 1 : 0;
    },
    del: async (key: string): Promise<number> => {
      log.del.push(key);
      const had = store.has(key);
      store.delete(key);
      ttls.delete(key);
      return had ? 1 : 0;
    },
    exists: async (key: string): Promise<number> => {
      log.exists.push(key);
      return store.has(key) ? 1 : 0;
    },
  };

  return {
    redis: api as unknown as IORedis,
    log,
    store,
    ttls,
    seed(key: string, hash: Record<string, string>): void {
      store.set(key, { ...hash });
    },
  };
}

function buildWebhookAccepted(overrides: Partial<WebhookAcceptedEvent> = {}): WebhookAcceptedEvent {
  return {
    type: 'webhook.accepted',
    timestamp: 1,
    traceId: 'trace-1',
    provider: 'jira',
    contextId: 'SPE-1977',
    contextTitle: 'Orphan detection',
    contextStatus: 'In Development',
    ...overrides,
  };
}

function buildJobStarted(overrides: Partial<JobStartedEvent> = {}): JobStartedEvent {
  return {
    type: 'job.started',
    timestamp: 1000,
    traceId: 'trace-1',
    jobId: 'job-1',
    provider: 'jira',
    agentId: 'patch',
    template: 'templates/jira-ready-for-dev-bug.md',
    runner: 'claude-cli',
    model: 'claude-opus-4-7',
    ...overrides,
  };
}

function buildJobCompleted(overrides: Partial<JobCompletedEvent> = {}): JobCompletedEvent {
  return {
    type: 'job.completed',
    timestamp: 5000,
    traceId: 'trace-1',
    jobId: 'job-1',
    provider: 'jira',
    durationMs: 4000,
    runId: 'cli-1',
    ...overrides,
  };
}

function buildJobFailed(overrides: Partial<JobFailedEvent> = {}): JobFailedEvent {
  return {
    type: 'job.failed',
    timestamp: 5000,
    traceId: 'trace-1',
    jobId: 'job-1',
    provider: 'jira',
    error: 'boom',
    attempt: 1,
    final: false,
    ...overrides,
  };
}

function buildRunnerAssistantText(
  overrides: Partial<RunnerAssistantTextEvent> = {},
): RunnerAssistantTextEvent {
  return {
    type: 'runner.assistant_text',
    timestamp: 2000,
    traceId: 'trace-1',
    jobId: 'job-1',
    runId: 'cli-1',
    text: 'thinking...',
    ...overrides,
  };
}

async function publishAndFlush(event: ClawndomEvent): Promise<void> {
  getEventBus().publish(event);
  // Give microtasks queued by the async handler a chance to run.
  await new Promise((resolve) => setImmediate(resolve));
}

describe('InflightRegistry', () => {
  beforeEach(() => {
    resetEventBus();
  });

  afterEach(() => {
    resetEventBus();
  });

  it('records a Redis hash with TTL when job.started fires after webhook.accepted', async () => {
    const fake = createFakeRedis();
    const registry = new InflightRegistry(fake.redis);
    registry.start();

    await publishAndFlush(buildWebhookAccepted());
    await publishAndFlush(buildJobStarted());

    const key = buildInflightKey('trace-1');
    expect(fake.log.hset).toHaveLength(1);
    expect(fake.log.hset[0]).toMatchObject({
      key,
      data: {
        traceId: 'trace-1',
        jobId: 'job-1',
        provider: 'jira',
        agentId: 'patch',
        contextId: 'SPE-1977',
        contextTitle: 'Orphan detection',
        contextStatus: 'In Development',
        startedAt: '1000',
        lastEventAt: '1000',
        lastEventType: 'job.started',
      },
    });
    expect(fake.log.expire).toEqual([{ key, seconds: 24 * 60 * 60 }]);
  });

  it('records a hash without context fields when webhook.accepted is missing', async () => {
    const fake = createFakeRedis();
    new InflightRegistry(fake.redis).start();

    await publishAndFlush(buildJobStarted());

    expect(fake.log.hset).toHaveLength(1);
    const data = fake.log.hset[0]!.data;
    expect(data['contextId']).toBeUndefined();
    expect(data['contextTitle']).toBeUndefined();
    expect(data['contextStatus']).toBeUndefined();
  });

  it('updates lastEventAt and lastEventType on runner.assistant_text', async () => {
    const fake = createFakeRedis();
    new InflightRegistry(fake.redis).start();
    await publishAndFlush(buildJobStarted());
    fake.log.hset = [];

    await publishAndFlush(buildRunnerAssistantText({ timestamp: 3000 }));

    expect(fake.log.hset).toHaveLength(1);
    expect(fake.log.hset[0]!.data).toEqual({
      lastEventAt: '3000',
      lastEventType: 'runner.assistant_text',
    });
  });

  it('does not resurrect a deleted record on a late runner.* event', async () => {
    const fake = createFakeRedis();
    new InflightRegistry(fake.redis).start();
    await publishAndFlush(buildJobStarted());
    await publishAndFlush(buildJobCompleted());
    fake.log.hset = [];

    // A late runner.assistant_text arriving after job.completed must not
    // re-create the hash — that would leak a permanently-orphan record.
    await publishAndFlush(buildRunnerAssistantText({ timestamp: 9999 }));

    expect(fake.log.hset).toHaveLength(0);
    expect(fake.store.has(buildInflightKey('trace-1'))).toBe(false);
  });

  it('DELs the hash on job.completed', async () => {
    const fake = createFakeRedis();
    new InflightRegistry(fake.redis).start();
    await publishAndFlush(buildJobStarted());

    await publishAndFlush(buildJobCompleted());

    expect(fake.log.del).toEqual([buildInflightKey('trace-1')]);
    expect(fake.store.has(buildInflightKey('trace-1'))).toBe(false);
  });

  it('keeps the hash on a non-final job.failed (retries reuse the trace)', async () => {
    const fake = createFakeRedis();
    new InflightRegistry(fake.redis).start();
    await publishAndFlush(buildJobStarted());

    await publishAndFlush(buildJobFailed({ final: false }));

    expect(fake.log.del).toEqual([]);
    expect(fake.store.has(buildInflightKey('trace-1'))).toBe(true);
  });

  it('DELs the hash on a final job.failed', async () => {
    const fake = createFakeRedis();
    new InflightRegistry(fake.redis).start();
    await publishAndFlush(buildJobStarted());

    await publishAndFlush(buildJobFailed({ final: true }));

    expect(fake.log.del).toEqual([buildInflightKey('trace-1')]);
  });

  it('readRecord round-trips the hash back into a typed record', async () => {
    const fake = createFakeRedis();
    const registry = new InflightRegistry(fake.redis);
    registry.start();
    await publishAndFlush(buildWebhookAccepted());
    await publishAndFlush(buildJobStarted());

    const record = await registry.readRecord('trace-1');

    expect(record).toEqual({
      traceId: 'trace-1',
      jobId: 'job-1',
      provider: 'jira',
      agentId: 'patch',
      contextId: 'SPE-1977',
      contextTitle: 'Orphan detection',
      contextStatus: 'In Development',
      startedAt: 1000,
      lastEventAt: 1000,
      lastEventType: 'job.started',
    });
  });

  it('readRecord returns null for an unknown traceId', async () => {
    const fake = createFakeRedis();
    const registry = new InflightRegistry(fake.redis);

    const record = await registry.readRecord('trace-missing');

    expect(record).toBeNull();
  });

  it('stop() unsubscribes — later events do not touch Redis', async () => {
    const fake = createFakeRedis();
    const registry = new InflightRegistry(fake.redis);
    registry.start();
    registry.stop();

    await publishAndFlush(buildJobStarted());

    expect(fake.log.hset).toEqual([]);
  });

  it('double-start is a no-op', async () => {
    const fake = createFakeRedis();
    const registry = new InflightRegistry(fake.redis);
    registry.start();
    registry.start();

    await publishAndFlush(buildJobStarted());

    expect(fake.log.hset).toHaveLength(1);
  });
});

describe('getInflightRegistry singleton', () => {
  beforeEach(() => {
    resetInflightRegistry();
    resetEventBus();
  });

  afterEach(() => {
    resetInflightRegistry();
    resetEventBus();
  });

  it('returns the same instance across calls and starts it eagerly', () => {
    const a = getInflightRegistry();
    const b = getInflightRegistry();
    expect(a).toBe(b);
    // Eager start means the singleton is already subscribed to the bus.
    expect(getEventBus().listenerCount()).toBe(1);
  });

  it('resetInflightRegistry stops the singleton and clears its subscription', () => {
    getInflightRegistry();
    expect(getEventBus().listenerCount()).toBe(1);

    resetInflightRegistry();
    expect(getEventBus().listenerCount()).toBe(0);
  });

  it('resetInflightRegistry is a no-op when no singleton exists', () => {
    expect(() => resetInflightRegistry()).not.toThrow();
  });
});

describe('parseInflightHash', () => {
  it('returns null when required fields are missing', () => {
    expect(parseInflightHash({})).toBeNull();
    expect(parseInflightHash({ traceId: 't' })).toBeNull();
  });

  it('returns null when timestamps are not numeric', () => {
    expect(
      parseInflightHash({
        traceId: 't',
        jobId: 'j',
        provider: 'p',
        agentId: 'a',
        startedAt: 'not-a-number',
        lastEventAt: '1',
        lastEventType: 'job.started',
      }),
    ).toBeNull();
  });

  it('returns a complete record when all required fields are present', () => {
    expect(
      parseInflightHash({
        traceId: 't',
        jobId: 'j',
        provider: 'p',
        agentId: 'a',
        startedAt: '100',
        lastEventAt: '200',
        lastEventType: 'job.started',
      }),
    ).toEqual({
      traceId: 't',
      jobId: 'j',
      provider: 'p',
      agentId: 'a',
      startedAt: 100,
      lastEventAt: 200,
      lastEventType: 'job.started',
    });
  });
});
