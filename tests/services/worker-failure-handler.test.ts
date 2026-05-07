import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';

const dedupRedisMock = {
  hgetall: vi.fn<(key: string) => Promise<Record<string, string>>>(),
};

vi.mock('../../src/services/dedup.service', () => ({
  getDedupRedis: (): typeof dedupRedisMock => dedupRedisMock,
}));

import { buildFailedHandler } from '../../src/services/worker-failure-handler';
import { buildInflightKey } from '../../src/services/inflight-registry.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import { AlertRegistry } from '../../src/services/alerts/registry';
import type { AlertProvider, JobAlert } from '../../src/services/alerts';
import type { ProviderConfig } from '../../src/config';
import type {
  ClawndomEvent,
  JobFailedEvent,
  JobRetriedEvent,
} from '../../src/types/clawndom-event';

function buildProvider(): ProviderConfig {
  return {
    name: 'jira',
    type: 'webhook',
    agent: 'patch',
  } as unknown as ProviderConfig;
}

function buildJob(
  id: string,
  envelope: { payload: string; attempt: number; originalJobId?: string },
): Job<string> {
  return {
    id,
    data: JSON.stringify(envelope),
  } as unknown as Job<string>;
}

interface QueueAddCall {
  name: string;
  data: string;
  opts: { delay?: number };
}

function createMockQueue(): { queue: Queue; calls: QueueAddCall[] } {
  const calls: QueueAddCall[] = [];
  const queue = {
    add: vi
      .fn<(name: string, data: string, opts: { delay?: number }) => Promise<{ id: string }>>()
      .mockImplementation(async (name, data, opts) => {
        calls.push({ name, data, opts });
        return { id: 'requeued-1' };
      }),
  } as unknown as Queue;
  return { queue, calls };
}

function buildInflightHash(
  overrides: Partial<{
    traceId: string;
    jobId: string;
    provider: string;
    agentId: string;
    contextId: string;
    contextTitle: string;
    contextStatus: string;
  }> = {},
): Record<string, string> {
  const hash: Record<string, string> = {
    traceId: overrides.traceId ?? 'trace-1',
    jobId: overrides.jobId ?? 'job-1',
    provider: overrides.provider ?? 'jira',
    agentId: overrides.agentId ?? 'patch',
    startedAt: '1000',
    lastEventAt: '2000',
    lastEventType: 'job.started',
  };
  if (overrides.contextId !== undefined) hash['contextId'] = overrides.contextId;
  if (overrides.contextTitle !== undefined) hash['contextTitle'] = overrides.contextTitle;
  if (overrides.contextStatus !== undefined) hash['contextStatus'] = overrides.contextStatus;
  return hash;
}

async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('buildFailedHandler', () => {
  beforeEach(() => {
    resetEventBus();
    dedupRedisMock.hgetall.mockReset();
  });

  afterEach(() => {
    resetEventBus();
  });

  it('enriches the final-failure alert with agentId and contextId from the inflight record', async () => {
    dedupRedisMock.hgetall.mockResolvedValue(
      buildInflightHash({
        agentId: 'patch',
        contextId: 'SPE-1977',
        contextTitle: 'Orphan detection',
        contextStatus: 'In Development',
      }),
    );
    const sent: JobAlert[] = [];
    const recording: AlertProvider = {
      name: 'recording',
      async send(alert) {
        sent.push(alert);
      },
    };
    const registry = new AlertRegistry([recording]);
    const { queue } = createMockQueue();
    const handler = buildFailedHandler(buildProvider(), queue, registry, 3);

    const job = buildJob('bullmq-1', { payload: 'p', attempt: 3, originalJobId: 'trace-1' });
    handler(job, new Error('Gateway returned 500'));
    await flushMicrotasks();

    expect(dedupRedisMock.hgetall).toHaveBeenCalledWith(buildInflightKey('trace-1'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      jobId: 'trace-1',
      agentId: 'patch',
      sessionKey: 'agent:patch:hook-jira-trace-1',
      attempts: 3,
      maxAttempts: 3,
      provider: 'jira',
      error: 'Gateway returned 500',
      kind: 'final-failure',
      contextId: 'SPE-1977',
      contextTitle: 'Orphan detection',
      contextStatus: 'In Development',
    });
  });

  it('falls back to agentId=unknown when no inflight record exists', async () => {
    dedupRedisMock.hgetall.mockResolvedValue({});
    const sent: JobAlert[] = [];
    const recording: AlertProvider = {
      name: 'recording',
      async send(alert) {
        sent.push(alert);
      },
    };
    const registry = new AlertRegistry([recording]);
    const { queue } = createMockQueue();
    const handler = buildFailedHandler(buildProvider(), queue, registry, 2);

    const job = buildJob('bullmq-1', { payload: 'p', attempt: 2, originalJobId: 'trace-1' });
    handler(job, new Error('boom'));
    await flushMicrotasks();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      agentId: 'unknown',
      sessionKey: 'agent:unknown:hook-jira-trace-1',
      kind: 'final-failure',
    });
    expect(sent[0]!).not.toHaveProperty('contextId');
  });

  it('still emits an alert with agentId=unknown when the inflight lookup throws', async () => {
    dedupRedisMock.hgetall.mockRejectedValue(new Error('redis down'));
    const sent: JobAlert[] = [];
    const recording: AlertProvider = {
      name: 'recording',
      async send(alert) {
        sent.push(alert);
      },
    };
    const registry = new AlertRegistry([recording]);
    const { queue } = createMockQueue();
    const handler = buildFailedHandler(buildProvider(), queue, registry, 1);

    const job = buildJob('bullmq-1', { payload: 'p', attempt: 1, originalJobId: 'trace-1' });
    handler(job, new Error('boom'));
    await flushMicrotasks();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe('unknown');
  });

  it('publishes job.failed with final=true on the last attempt', async () => {
    dedupRedisMock.hgetall.mockResolvedValue({});
    const events: ClawndomEvent[] = [];
    getEventBus().subscribe((s) => events.push(s.event));
    const { queue } = createMockQueue();
    const handler = buildFailedHandler(buildProvider(), queue, undefined, 2);

    const job = buildJob('bullmq-1', { payload: 'p', attempt: 2, originalJobId: 'trace-1' });
    handler(job, new Error('boom'));
    await flushMicrotasks();

    const failed = events.filter((e): e is JobFailedEvent => e.type === 'job.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      type: 'job.failed',
      traceId: 'trace-1',
      jobId: 'bullmq-1',
      provider: 'jira',
      error: 'boom',
      attempt: 2,
      final: true,
    });
  });

  it('does not dispatch an alert and requeues to the back on a non-final failure', async () => {
    const sent: JobAlert[] = [];
    const recording: AlertProvider = {
      name: 'recording',
      async send(alert) {
        sent.push(alert);
      },
    };
    const registry = new AlertRegistry([recording]);
    const { queue, calls } = createMockQueue();
    const events: ClawndomEvent[] = [];
    getEventBus().subscribe((s) => events.push(s.event));
    const handler = buildFailedHandler(buildProvider(), queue, registry, 3);

    const job = buildJob('bullmq-1', { payload: 'p', attempt: 1, originalJobId: 'trace-1' });
    handler(job, new Error('transient'));
    await flushMicrotasks();

    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('webhook-event');
    expect(calls[0]!.opts.delay).toBe(5_000);

    // Non-final failure must not trigger an inflight lookup — the lookup
    // is reserved for the alert path (final failure).
    expect(dedupRedisMock.hgetall).not.toHaveBeenCalled();

    const retried = events.filter((e): e is JobRetriedEvent => e.type === 'job.retried');
    expect(retried).toHaveLength(1);
    expect(retried[0]!.attempt).toBe(2);
  });

  it('snapshots the inflight record before the InflightRegistry can DEL it', async () => {
    // Race regression: the EventBus subscriber for `job.failed(final=true)`
    // DELs the inflight key. If the handler reads the hash AFTER publishing,
    // the alert payload loses its agentId/contextId. This test enforces
    // ordering by mutating the hash on the very first hgetall call — if the
    // handler ever swaps the order, the alert will see the mutated/empty
    // hash instead of the original record.
    let lookupCount = 0;
    dedupRedisMock.hgetall.mockImplementation(async () => {
      lookupCount += 1;
      if (lookupCount === 1) {
        return buildInflightHash({ agentId: 'patch', contextId: 'SPE-1977' });
      }
      return {};
    });
    const sent: JobAlert[] = [];
    const recording: AlertProvider = {
      name: 'recording',
      async send(alert) {
        sent.push(alert);
      },
    };
    const registry = new AlertRegistry([recording]);
    const { queue } = createMockQueue();
    const handler = buildFailedHandler(buildProvider(), queue, registry, 1);

    const job = buildJob('bullmq-1', { payload: 'p', attempt: 1, originalJobId: 'trace-1' });
    handler(job, new Error('boom'));
    await flushMicrotasks();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe('patch');
    expect(sent[0]!.contextId).toBe('SPE-1977');
  });

  it('preserves envelope.context onto the requeued envelope', async () => {
    const { queue, calls } = createMockQueue();
    const handler = buildFailedHandler(buildProvider(), queue, undefined, 3);

    const envelopeWithContext = {
      payload: 'p',
      attempt: 1,
      originalJobId: 'trace-1',
      context: { id: 'SPE-2009', title: 'Empty fourth page', status: 'Plan' },
    };
    const job = {
      id: 'bullmq-1',
      data: JSON.stringify(envelopeWithContext),
    } as unknown as Job<string>;

    handler(job, new Error('transient'));
    await flushMicrotasks();

    expect(calls).toHaveLength(1);
    const requeuedEnvelope = JSON.parse(calls[0]!.data) as Record<string, unknown>;
    expect(requeuedEnvelope.context).toEqual({
      id: 'SPE-2009',
      title: 'Empty fourth page',
      status: 'Plan',
    });
    expect(requeuedEnvelope.attempt).toBe(2);
  });

  it('uses job.id as the traceId when the envelope has no originalJobId', async () => {
    dedupRedisMock.hgetall.mockResolvedValue({});
    const events: ClawndomEvent[] = [];
    getEventBus().subscribe((s) => events.push(s.event));
    const { queue } = createMockQueue();
    const handler = buildFailedHandler(buildProvider(), queue, undefined, 1);

    const job = buildJob('bullmq-fresh', { payload: 'p', attempt: 1 });
    handler(job, new Error('boom'));
    await flushMicrotasks();

    const failed = events.find((e): e is JobFailedEvent => e.type === 'job.failed');
    expect(failed!.traceId).toBe('bullmq-fresh');
  });
});
