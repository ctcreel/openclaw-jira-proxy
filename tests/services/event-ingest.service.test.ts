import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ProviderConfig } from '../../src/config';
import { resetSettings } from '../../src/config';
import { EventBus } from '../../src/services/event-bus.service';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';
import type { ClawndomEvent } from '../../src/types/clawndom-event';

const { dedupSetMock, queueAddMock } = vi.hoisted(() => ({
  dedupSetMock: vi.fn<[string, string, string, number, string], Promise<string | null>>(),
  queueAddMock: vi.fn<[string, string], Promise<{ id: string }>>(),
}));

vi.mock('../../src/services/dedup.service', () => ({
  getDedupRedis: (): { set: typeof dedupSetMock } => ({ set: dedupSetMock }),
}));

vi.mock('../../src/services/queue.service', () => ({
  getProviderQueue: (): { add: typeof queueAddMock } => ({ add: queueAddMock }),
}));

import { ingestEvent } from '../../src/services/event-ingest.service';

const jiraProvider: ProviderConfig = {
  name: 'jira',
  transport: 'webhook',
  routePath: '/hooks/jira',
  hmacSecret: 'h',
  signatureStrategy: 'websub',
};

const unknownProvider: ProviderConfig = {
  name: 'unknown-provider',
  transport: 'webhook',
  routePath: '/hooks/unk',
  hmacSecret: 'h',
  signatureStrategy: 'websub',
};

function catchAllAgent(providerName: string): ResolvedAgent {
  return {
    name: 'patch',
    dir: '/agents/patch',
    config: {
      routing: { [providerName]: { rules: [{ condition: { all_of: [] } }] } },
      modelRules: {},
    },
  };
}

function captureEvents(bus: EventBus): ClawndomEvent[] {
  const out: ClawndomEvent[] = [];
  bus.subscribe((s) => out.push(s.event));
  return out;
}

describe('ingestEvent', () => {
  let bus: EventBus;

  beforeEach(() => {
    resetSettings();
    dedupSetMock.mockReset();
    queueAddMock.mockReset();
    bus = new EventBus();
  });

  it('publishes webhook.rejected with reason "no-routing-match" when no agent matches', async () => {
    const events = captureEvents(bus);
    const noMatchAgent: ResolvedAgent = {
      name: 'patch',
      dir: '/x',
      config: { routing: {}, modelRules: {} },
    };
    const payload = { issue: { key: 'SPE-1', fields: { summary: 's', status: { name: 'Open' } } } };

    const result = await ingestEvent({
      provider: jiraProvider,
      agents: [noMatchAgent],
      rawBodyString: JSON.stringify(payload),
      parsedPayload: payload,
      traceId: 'trace-1',
      events: bus,
    });

    expect(result).toEqual({ outcome: 'no-routing-match' });
    expect(queueAddMock).not.toHaveBeenCalled();
    expect(dedupSetMock).not.toHaveBeenCalled();
    const rejected = events.find((e) => e.type === 'webhook.rejected');
    expect(rejected).toMatchObject({
      type: 'webhook.rejected',
      reason: 'no-routing-match',
      traceId: 'trace-1',
      provider: 'jira',
    });
  });

  it('publishes webhook.rejected with reason "duplicate" when dedup says already-seen', async () => {
    dedupSetMock.mockResolvedValue(null);
    const events = captureEvents(bus);
    const payload = {
      issue: { key: 'SPE-2', fields: { summary: 'Dup', status: { name: 'Open' } } },
    };

    const result = await ingestEvent({
      provider: jiraProvider,
      agents: [catchAllAgent('jira')],
      rawBodyString: JSON.stringify(payload),
      parsedPayload: payload,
      traceId: 'trace-2',
      events: bus,
    });

    expect(result).toEqual({ outcome: 'duplicate' });
    expect(dedupSetMock).toHaveBeenCalledOnce();
    expect(dedupSetMock).toHaveBeenCalledWith(
      expect.stringContaining('clawndom:dedup:jira:SPE-2:Open'),
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
    expect(queueAddMock).not.toHaveBeenCalled();
    const rejected = events.find((e) => e.type === 'webhook.rejected');
    expect(rejected).toMatchObject({
      type: 'webhook.rejected',
      reason: 'duplicate',
      traceId: 'trace-2',
    });
  });

  it('enqueues and publishes webhook.accepted + job.queued on first sight', async () => {
    dedupSetMock.mockResolvedValue('OK');
    queueAddMock.mockResolvedValue({ id: 'job-99' });
    const events = captureEvents(bus);
    const payload = {
      issue: { key: 'SPE-3', fields: { summary: 'New', status: { name: 'Ready' } } },
    };
    const rawBodyString = JSON.stringify(payload);

    const result = await ingestEvent({
      provider: jiraProvider,
      agents: [catchAllAgent('jira')],
      rawBodyString,
      parsedPayload: payload,
      traceId: 'trace-pre',
      events: bus,
    });

    expect(result).toEqual({ outcome: 'enqueued', jobTraceId: 'job-99' });
    // Envelope shape, not the raw body — context must persist onto the
    // BullMQ payload so a worker pickup after a clawndom restart can still
    // recover trace_context. Asserting on parsed envelope rather than
    // exact string keeps the test resilient to JSON whitespace drift.
    expect(queueAddMock).toHaveBeenCalledOnce();
    const enqueuedData = queueAddMock.mock.calls[0]![1];
    const enqueuedEnvelope = JSON.parse(enqueuedData) as Record<string, unknown>;
    expect(enqueuedEnvelope).toMatchObject({
      payload: rawBodyString,
      attempt: 1,
      context: { id: 'SPE-3', title: expect.any(String), status: 'Ready' },
    });

    const accepted = events.find((e) => e.type === 'webhook.accepted');
    expect(accepted).toMatchObject({
      type: 'webhook.accepted',
      traceId: 'job-99',
      provider: 'jira',
      contextId: 'SPE-3',
      contextStatus: 'Ready',
    });
    const queued = events.find((e) => e.type === 'job.queued');
    expect(queued).toMatchObject({
      type: 'job.queued',
      traceId: 'job-99',
      jobId: 'job-99',
      provider: 'jira',
      contextId: 'SPE-3',
    });
  });

  it('skips dedup but still enqueues when context.id is "?"', async () => {
    queueAddMock.mockResolvedValue({ id: 'job-100' });
    const events = captureEvents(bus);
    const payload = { something: 'opaque' };

    const result = await ingestEvent({
      provider: unknownProvider,
      agents: [catchAllAgent('unknown-provider')],
      rawBodyString: JSON.stringify(payload),
      parsedPayload: payload,
      traceId: 'trace-pre',
      events: bus,
    });

    expect(result).toEqual({ outcome: 'enqueued', jobTraceId: 'job-100' });
    expect(dedupSetMock).not.toHaveBeenCalled();
    expect(queueAddMock).toHaveBeenCalledOnce();
    expect(events.some((e) => e.type === 'webhook.accepted')).toBe(true);
    expect(events.some((e) => e.type === 'job.queued')).toBe(true);
  });

  it('uses jobTraceId="unknown" when BullMQ does not assign an id', async () => {
    dedupSetMock.mockResolvedValue('OK');
    queueAddMock.mockResolvedValue({ id: undefined as unknown as string });
    const events = captureEvents(bus);
    const payload = {
      issue: { key: 'SPE-4', fields: { summary: 's', status: { name: 'Open' } } },
    };

    const result = await ingestEvent({
      provider: jiraProvider,
      agents: [catchAllAgent('jira')],
      rawBodyString: JSON.stringify(payload),
      parsedPayload: payload,
      traceId: 'trace-pre',
      events: bus,
    });

    expect(result).toEqual({ outcome: 'enqueued', jobTraceId: 'unknown' });
    const accepted = events.find((e) => e.type === 'webhook.accepted');
    expect(accepted).toMatchObject({ traceId: 'unknown' });
  });
});
