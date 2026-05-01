/**
 * Integration test for SPE-1978 acceptance criterion #4:
 * fire three rejected webhooks (mix of no-match and duplicate) through the
 * actual ingest path, then verify the GET /api/webhooks/skipped/recent
 * response carries both the breakdown counts and the per-event context.
 *
 * Mocked: dedup Redis + BullMQ queue.add (so the ingest path runs without
 * external dependencies). Real: EventBus, SkippedWebhooksRegistry, Express
 * controller.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ProviderConfig } from '../../src/config';
import { resetSettings } from '../../src/config';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import {
  getSkippedWebhooksRegistry,
  resetSkippedWebhooksRegistry,
} from '../../src/services/skipped-webhooks.service';
import { listRecentSkippedWebhooks } from '../../src/controllers/skipped-webhooks.controller';

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

const jiraProvider: ProviderConfig = {
  name: 'jira',
  transport: 'webhook',
  routePath: '/hooks/jira',
  hmacSecret: 'h',
  signatureStrategy: 'websub',
};

function catchAllAgent(): ResolvedAgent {
  return {
    name: 'patch',
    dir: '/agents/patch',
    config: {
      routing: { jira: { rules: [{ condition: { all_of: [] } }] } },
      modelRules: {},
    },
  };
}

function noMatchAgent(): ResolvedAgent {
  return {
    name: 'patch',
    dir: '/agents/patch',
    config: { routing: {}, modelRules: {} },
  };
}

interface SkippedResponseBody {
  skipped: Array<Record<string, unknown>>;
  counts: { noMatch: number; duplicate: number; signatureFailure: number };
}

describe('integration: skipped-webhooks endpoint reflects ingest-path rejections', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    resetSettings();
    resetEventBus();
    resetSkippedWebhooksRegistry();
    dedupSetMock.mockReset();
    queueAddMock.mockReset();

    // Eagerly bootstrap so the registry is subscribed before any event fires.
    getSkippedWebhooksRegistry();

    const app = express();
    app.get('/api/webhooks/skipped/recent', listRecentSkippedWebhooks);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('captures no-match + duplicate events through ingestEvent and exposes them via GET', async () => {
    const { ingestEvent } = await import('../../src/services/event-ingest.service');
    const bus = getEventBus();

    // 1) no-routing-match — no agent rule matches Jira at all.
    const noMatchPayload = {
      issue: {
        key: 'SPE-501',
        fields: { summary: 'Comment-only fan-out', status: { name: 'Backlog' } },
      },
    };
    await ingestEvent({
      provider: jiraProvider,
      agents: [noMatchAgent()],
      rawBodyString: JSON.stringify(noMatchPayload),
      parsedPayload: noMatchPayload,
      traceId: 'trace-no-match-1',
      events: bus,
    });

    // 2) no-routing-match — second one for breakdown >1.
    const noMatchPayload2 = {
      issue: { key: 'SPE-502', fields: { summary: 'Other fan-out', status: { name: 'Triage' } } },
    };
    await ingestEvent({
      provider: jiraProvider,
      agents: [noMatchAgent()],
      rawBodyString: JSON.stringify(noMatchPayload2),
      parsedPayload: noMatchPayload2,
      traceId: 'trace-no-match-2',
      events: bus,
    });

    // 3) duplicate — agent matches, but dedup says we've already seen this tuple.
    dedupSetMock.mockResolvedValue(null);
    const dupePayload = {
      issue: {
        key: 'SPE-600',
        fields: { summary: 'Replay', status: { name: 'Ready for Development' } },
      },
    };
    await ingestEvent({
      provider: jiraProvider,
      agents: [catchAllAgent()],
      rawBodyString: JSON.stringify(dupePayload),
      parsedPayload: dupePayload,
      traceId: 'trace-duplicate',
      events: bus,
    });

    // GET the endpoint.
    const response = await fetch(`${baseUrl}/api/webhooks/skipped/recent`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SkippedResponseBody;

    expect(body.counts).toEqual({ noMatch: 2, duplicate: 1, signatureFailure: 0 });
    expect(body.skipped).toHaveLength(3);

    // Most-recent-first; duplicate published last.
    expect(body.skipped[0]).toMatchObject({
      reason: 'duplicate',
      provider: 'jira',
      contextId: 'SPE-600',
      contextStatus: 'Ready for Development',
      traceId: 'trace-duplicate',
    });
    expect(body.skipped[1]).toMatchObject({
      reason: 'no-routing-match',
      contextId: 'SPE-502',
      contextStatus: 'Triage',
    });
    expect(body.skipped[2]).toMatchObject({
      reason: 'no-routing-match',
      contextId: 'SPE-501',
      contextStatus: 'Backlog',
    });
  });
});
