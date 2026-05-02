import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type IORedis from 'ioredis';
import type { JobType } from 'bullmq';

const upsertCalls: Array<{ id: string; opts: unknown; template: unknown }> = [];

vi.mock('bullmq', () => {
  class QueueMock {
    async upsertJobScheduler(id: string, opts: unknown, template: unknown): Promise<void> {
      upsertCalls.push({ id, opts, template });
    }
    async close(): Promise<undefined> {
      return undefined;
    }
  }
  class WorkerMock {
    on(): this {
      return this;
    }
    async close(): Promise<undefined> {
      return undefined;
    }
  }
  return { Queue: QueueMock, Worker: WorkerMock };
});

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({ disconnect: vi.fn() })),
}));

const providerQueueMock = {
  getJob: vi.fn(),
};
vi.mock('../../src/services/queue.service', () => ({
  getProviderQueue: vi.fn(() => providerQueueMock),
}));

vi.mock('../../src/config', () => ({
  getSettings: vi.fn(() => ({
    redisUrl: 'redis://localhost:6379',
    orphanThresholdMs: 30 * 60_000,
    orphanReaperIntervalMs: 60_000,
  })),
}));

vi.mock('../../src/services/dedup.service', () => ({
  getDedupRedis: vi.fn(() => ({
    scan: vi.fn().mockResolvedValue(['0', []]),
    hgetall: vi.fn().mockResolvedValue({}),
    del: vi.fn().mockResolvedValue(0),
  })),
}));

import {
  OrphanReaper,
  REAPER_QUEUE_NAME,
  REAPER_SCHEDULER_ID,
  getOrphanReaper,
  resetOrphanReaper,
} from '../../src/services/orphan-reaper.service';
import { buildInflightKey } from '../../src/services/inflight-registry.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import { AlertRegistry } from '../../src/services/alerts/registry';
import type { AlertProvider, JobAlert } from '../../src/services/alerts';
import type { ClawndomEvent, JobOrphanedEvent } from '../../src/types/clawndom-event';

const NOW = 10_000_000;
const THRESHOLD_MS = 60_000;
const INTERVAL_MS = 30_000;

interface FakeRedis {
  redis: IORedis;
  store: Map<string, Record<string, string>>;
  deleted: string[];
  /** Override the scan implementation (e.g. for cursor pagination tests). */
  scan: ReturnType<typeof vi.fn>;
}

function createFakeRedis(seedHashes: Record<string, Record<string, string>> = {}): FakeRedis {
  const store = new Map<string, Record<string, string>>();
  for (const [k, v] of Object.entries(seedHashes)) {
    store.set(k, { ...v });
  }
  const deleted: string[] = [];
  const scan = vi
    .fn<(cursor: string, ...args: unknown[]) => Promise<[string, string[]]>>()
    .mockImplementation(async (cursor) => {
      if (cursor !== '0') return ['0', []];
      return ['0', [...store.keys()]];
    });
  const redis = {
    scan,
    hgetall: async (key: string): Promise<Record<string, string>> => store.get(key) ?? {},
    del: async (key: string): Promise<number> => {
      deleted.push(key);
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    },
  };
  return { redis: redis as unknown as IORedis, store, deleted, scan };
}

interface HashOverrides {
  traceId?: string;
  jobId?: string;
  provider?: string;
  agentId?: string;
  startedAt?: number;
  lastEventAt?: number;
  lastEventType?: string;
  contextId?: string;
  contextTitle?: string;
  contextStatus?: string;
}

function buildHash(overrides: HashOverrides = {}): Record<string, string> {
  const hash: Record<string, string> = {
    traceId: overrides.traceId ?? 'trace-1',
    jobId: overrides.jobId ?? 'job-1',
    provider: overrides.provider ?? 'jira',
    agentId: overrides.agentId ?? 'patch',
    startedAt: String(overrides.startedAt ?? NOW - THRESHOLD_MS - 1),
    lastEventAt: String(overrides.lastEventAt ?? NOW - THRESHOLD_MS - 1),
    lastEventType: overrides.lastEventType ?? 'job.started',
  };
  if (overrides.contextId !== undefined) hash['contextId'] = overrides.contextId;
  if (overrides.contextTitle !== undefined) hash['contextTitle'] = overrides.contextTitle;
  if (overrides.contextStatus !== undefined) hash['contextStatus'] = overrides.contextStatus;
  return hash;
}

function setBullmqState(state: JobType | null): void {
  if (state === null) {
    providerQueueMock.getJob.mockResolvedValue(null);
    return;
  }
  providerQueueMock.getJob.mockResolvedValue({
    getState: vi.fn().mockResolvedValue(state),
  });
}

describe('OrphanReaper.reapOnce', () => {
  beforeEach(() => {
    resetEventBus();
    upsertCalls.length = 0;
    providerQueueMock.getJob.mockReset();
  });

  afterEach(() => {
    resetEventBus();
  });

  it('returns scanned=0 / orphaned=0 when no inflight records exist', async () => {
    const fake = createFakeRedis();
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 0, orphaned: 0 });
    expect(fake.deleted).toEqual([]);
  });

  it('skips a fresh inflight whose lastEventAt is within the threshold', async () => {
    const key = buildInflightKey('trace-fresh');
    const fake = createFakeRedis({
      [key]: buildHash({ traceId: 'trace-fresh', lastEventAt: NOW - 1000 }),
    });
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 1, orphaned: 0 });
    expect(fake.deleted).toEqual([]);
    expect(fake.store.has(key)).toBe(true);
    expect(providerQueueMock.getJob).not.toHaveBeenCalled();
  });

  it('reaps a stale inflight whose BullMQ job is in completed state', async () => {
    const key = buildInflightKey('trace-1');
    const fake = createFakeRedis({
      [key]: buildHash({
        traceId: 'trace-1',
        contextId: 'SPE-1977',
        contextTitle: 'Orphan detection',
        contextStatus: 'In Development',
      }),
    });
    setBullmqState('completed');
    const events: ClawndomEvent[] = [];
    getEventBus().subscribe((s) => events.push(s.event));
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 1, orphaned: 1 });
    expect(fake.deleted).toEqual([key]);
    expect(fake.store.has(key)).toBe(false);
    const orphanEvents = events.filter((e): e is JobOrphanedEvent => e.type === 'job.orphaned');
    expect(orphanEvents).toHaveLength(1);
    expect(orphanEvents[0]).toMatchObject({
      type: 'job.orphaned',
      timestamp: NOW,
      traceId: 'trace-1',
      jobId: 'job-1',
      provider: 'jira',
      agentId: 'patch',
      contextId: 'SPE-1977',
      contextTitle: 'Orphan detection',
      contextStatus: 'In Development',
      lastEventType: 'job.started',
      reason: 'no-terminal-event',
    });
  });

  it('treats a missing BullMQ job (getJob returns null) as orphaned', async () => {
    const key = buildInflightKey('trace-vanished');
    const fake = createFakeRedis({ [key]: buildHash({ traceId: 'trace-vanished' }) });
    setBullmqState(null);
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 1, orphaned: 1 });
    expect(fake.deleted).toEqual([key]);
  });

  it('treats a BullMQ-lookup error as unknown and reaps the inflight', async () => {
    const key = buildInflightKey('trace-redis-down');
    const fake = createFakeRedis({ [key]: buildHash({ traceId: 'trace-redis-down' }) });
    providerQueueMock.getJob.mockRejectedValue(new Error('redis down'));
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 1, orphaned: 1 });
    expect(fake.deleted).toEqual([key]);
  });

  it('does NOT reap a stale inflight whose BullMQ job is still active', async () => {
    const key = buildInflightKey('trace-active');
    const fake = createFakeRedis({ [key]: buildHash({ traceId: 'trace-active' }) });
    setBullmqState('active');
    const events: ClawndomEvent[] = [];
    getEventBus().subscribe((s) => events.push(s.event));
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 1, orphaned: 0 });
    expect(fake.deleted).toEqual([]);
    expect(fake.store.has(key)).toBe(true);
    expect(events.filter((e) => e.type === 'job.orphaned')).toHaveLength(0);
  });

  it('does NOT reap when BullMQ reports waiting or delayed (still queued)', async () => {
    const key = buildInflightKey('trace-waiting');
    const fake = createFakeRedis({ [key]: buildHash({ traceId: 'trace-waiting' }) });
    setBullmqState('waiting');
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 1, orphaned: 0 });
    expect(fake.deleted).toEqual([]);
  });

  it('reaps stale inflights with failed BullMQ state (worker crashed mid-failure)', async () => {
    const key = buildInflightKey('trace-failed');
    const fake = createFakeRedis({ [key]: buildHash({ traceId: 'trace-failed' }) });
    setBullmqState('failed');
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 1, orphaned: 1 });
    expect(fake.deleted).toEqual([key]);
  });

  it('only reaps the stale records when fresh and stale coexist', async () => {
    const staleKey = buildInflightKey('trace-stale');
    const freshKey = buildInflightKey('trace-fresh');
    const fake = createFakeRedis({
      [staleKey]: buildHash({ traceId: 'trace-stale' }),
      [freshKey]: buildHash({ traceId: 'trace-fresh', lastEventAt: NOW - 1000 }),
    });
    setBullmqState('completed');
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 2, orphaned: 1 });
    expect(fake.deleted).toEqual([staleKey]);
    expect(fake.store.has(freshKey)).toBe(true);
  });

  it('omits context fields from the emitted event when the inflight has none', async () => {
    const key = buildInflightKey('trace-no-context');
    const fake = createFakeRedis({ [key]: buildHash({ traceId: 'trace-no-context' }) });
    setBullmqState('completed');
    const events: ClawndomEvent[] = [];
    getEventBus().subscribe((s) => events.push(s.event));
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    await reaper.reapOnce(NOW);

    const orphan = events.find((e): e is JobOrphanedEvent => e.type === 'job.orphaned');
    expect(orphan).toBeDefined();
    expect(orphan!).not.toHaveProperty('contextId');
    expect(orphan!).not.toHaveProperty('contextTitle');
    expect(orphan!).not.toHaveProperty('contextStatus');
  });

  it('skips inflight hashes that fail to parse (missing required fields)', async () => {
    const key = buildInflightKey('trace-broken');
    const fake = createFakeRedis({ [key]: { traceId: 'trace-broken' } });
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(result).toEqual({ scanned: 0, orphaned: 0 });
    expect(providerQueueMock.getJob).not.toHaveBeenCalled();
  });

  it('paginates SCAN cursors until completion', async () => {
    const k1 = buildInflightKey('trace-1');
    const k2 = buildInflightKey('trace-2');
    const fake = createFakeRedis({
      [k1]: buildHash({ traceId: 'trace-1' }),
      [k2]: buildHash({ traceId: 'trace-2' }),
    });
    fake.scan.mockReset();
    fake.scan.mockResolvedValueOnce(['42', [k1]]).mockResolvedValueOnce(['0', [k2]]);
    setBullmqState('completed');
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);

    const result = await reaper.reapOnce(NOW);

    expect(fake.scan).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ scanned: 2, orphaned: 2 });
    expect(fake.deleted.sort()).toEqual([k1, k2].sort());
  });
});

describe('OrphanReaper alert dispatch', () => {
  beforeEach(() => {
    resetEventBus();
    upsertCalls.length = 0;
    providerQueueMock.getJob.mockReset();
  });

  afterEach(() => {
    resetEventBus();
  });

  it('dispatches a JobAlert with kind=orphaned when reapOnce produces an orphan', async () => {
    const key = buildInflightKey('trace-1');
    const fake = createFakeRedis({
      [key]: buildHash({
        traceId: 'trace-1',
        contextId: 'SPE-1977',
        contextTitle: 'Orphan detection',
        contextStatus: 'In Development',
      }),
    });
    setBullmqState('completed');
    const sent: JobAlert[] = [];
    const recordingProvider: AlertProvider = {
      name: 'recording',
      async send(alert) {
        sent.push(alert);
      },
    };
    const alertRegistry = new AlertRegistry([recordingProvider]);
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS, alertRegistry);
    await reaper.start();

    await reaper.reapOnce(NOW);
    // sendAll is fire-and-forget inside the EventBus subscriber; flush microtasks.
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      jobId: 'job-1',
      provider: 'jira',
      agentId: 'patch',
      sessionKey: 'agent:patch:hook-jira-trace-1',
      kind: 'orphaned',
      attempts: 0,
      maxAttempts: 0,
      contextId: 'SPE-1977',
      contextTitle: 'Orphan detection',
      contextStatus: 'In Development',
    });
    expect(sent[0]!.error).toContain('no terminal event');
    expect(sent[0]!.failedAt).toBeInstanceOf(Date);

    await reaper.stop();
  });

  it('does not dispatch an alert when start() is called without an AlertRegistry', async () => {
    const key = buildInflightKey('trace-1');
    const fake = createFakeRedis({ [key]: buildHash({ traceId: 'trace-1' }) });
    setBullmqState('completed');
    const reaper = new OrphanReaper(fake.redis, THRESHOLD_MS, INTERVAL_MS);
    await reaper.start();

    // Just assert reapOnce does not throw and the event flows. The absence
    // of a registry is the regression we care about — no listener wiring.
    const events: ClawndomEvent[] = [];
    getEventBus().subscribe((s) => events.push(s.event));
    await reaper.reapOnce(NOW);

    expect(events.filter((e) => e.type === 'job.orphaned')).toHaveLength(1);

    await reaper.stop();
  });

  it('start() upserts the BullMQ scheduler with the configured interval', async () => {
    const reaper = new OrphanReaper(createFakeRedis().redis, THRESHOLD_MS, INTERVAL_MS);
    await reaper.start();

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.id).toBe(REAPER_SCHEDULER_ID);
    expect(upsertCalls[0]!.opts).toEqual({ every: INTERVAL_MS });

    await reaper.stop();
  });

  it('double-start is a no-op (does not register the scheduler twice)', async () => {
    const reaper = new OrphanReaper(createFakeRedis().redis, THRESHOLD_MS, INTERVAL_MS);
    await reaper.start();
    await reaper.start();

    expect(upsertCalls).toHaveLength(1);

    await reaper.stop();
  });
});

describe('getOrphanReaper singleton', () => {
  beforeEach(async () => {
    await resetOrphanReaper();
    resetEventBus();
  });

  afterEach(async () => {
    await resetOrphanReaper();
    resetEventBus();
  });

  it('returns the same instance across calls', () => {
    const a = getOrphanReaper();
    const b = getOrphanReaper();
    expect(a).toBe(b);
  });

  it('resetOrphanReaper stops the running singleton and clears it', async () => {
    const first = getOrphanReaper();
    await first.start();
    await resetOrphanReaper();

    const second = getOrphanReaper();
    expect(second).not.toBe(first);
  });

  it('resetOrphanReaper is a no-op when no singleton exists', async () => {
    await expect(resetOrphanReaper()).resolves.toBeUndefined();
  });
});

describe('OrphanReaper queue identifiers', () => {
  // SPE-1824 / SPE-1999: BullMQ uses ':' as its Redis key separator and
  // refuses to construct a Queue/Worker if the name contains ':'. The thick
  // BullMQ mock in this file skips that validation, which is why the prior
  // suite stayed green while production crash-looped on startup. Static
  // assertions on the exported constants close the loop without needing the
  // real BullMQ wired up here. Regression source: orphan-reaper.service.ts
  // shipped with `'clawndom:reaper'` / `'clawndom:orphan-reaper'`.

  it('REAPER_QUEUE_NAME never contains a colon', () => {
    expect(REAPER_QUEUE_NAME).not.toContain(':');
  });

  it('REAPER_SCHEDULER_ID never contains a colon', () => {
    expect(REAPER_SCHEDULER_ID).not.toContain(':');
  });

  // Stronger guard than the colon-only checks above — catches any future
  // special-character regression in BullMQ-name constants for free, not
  // just the specific colon case that triggered SPE-1999.
  const VALID_BULLMQ_NAME = /^[a-z][a-z0-9-]*$/;

  it('REAPER_QUEUE_NAME matches the BullMQ-safe name pattern', () => {
    expect(REAPER_QUEUE_NAME).toMatch(VALID_BULLMQ_NAME);
  });

  it('REAPER_SCHEDULER_ID matches the BullMQ-safe name pattern', () => {
    expect(REAPER_SCHEDULER_ID).toMatch(VALID_BULLMQ_NAME);
  });
});
