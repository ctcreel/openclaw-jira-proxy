import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { listRecentSkippedWebhooks } from '../../src/controllers/skipped-webhooks.controller';
import {
  getSkippedWebhooksRegistry,
  resetSkippedWebhooksRegistry,
} from '../../src/services/skipped-webhooks.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';

function mountApp(): Express {
  const app = express();
  app.get('/api/webhooks/skipped/recent', listRecentSkippedWebhooks);
  return app;
}

interface SkippedResponseBody {
  skipped: Array<Record<string, unknown>>;
  counts: {
    noMatch: number;
    duplicate: number;
    signatureFailure: number;
    senderGateRefusal: number;
  };
}

describe('GET /api/webhooks/skipped/recent', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    resetEventBus();
    resetSkippedWebhooksRegistry();
    const app = mountApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns an empty list and zero counts when no rejections have happened', async () => {
    getSkippedWebhooksRegistry();
    const response = await fetch(`${baseUrl}/api/webhooks/skipped/recent`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      skipped: [],
      counts: { noMatch: 0, duplicate: 0, signatureFailure: 0, senderGateRefusal: 0 },
    });
  });

  it('returns the breakdown and recent entries after a mix of rejections', async () => {
    getSkippedWebhooksRegistry();
    const bus = getEventBus();

    bus.publish({
      type: 'webhook.rejected',
      timestamp: 1,
      traceId: 't-1',
      provider: 'jira',
      reason: 'no-routing-match',
      contextId: 'SPE-1',
      contextStatus: 'Backlog',
      contextTitle: 'A',
    });
    bus.publish({
      type: 'webhook.rejected',
      timestamp: 2,
      traceId: 't-2',
      provider: 'jira',
      reason: 'duplicate',
      contextId: 'SPE-2',
      contextStatus: 'Code Review',
      contextTitle: 'B',
    });
    bus.publish({
      type: 'webhook.rejected',
      timestamp: 3,
      traceId: 't-3',
      provider: 'github',
      reason: 'invalid-signature',
    });
    bus.publish({
      type: 'webhook.rejected',
      timestamp: 4,
      traceId: 't-4',
      provider: 'builder-dispatch',
      reason: 'sender-gate-refusal',
    });

    const response = await fetch(`${baseUrl}/api/webhooks/skipped/recent`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as SkippedResponseBody;
    expect(body.counts).toEqual({
      noMatch: 1,
      duplicate: 1,
      signatureFailure: 1,
      senderGateRefusal: 1,
    });
    expect(body.skipped).toHaveLength(4);
    // most-recent-first
    expect(body.skipped[0]).toMatchObject({
      reason: 'sender-gate-refusal',
      provider: 'builder-dispatch',
      timestamp: 4,
    });
    expect(body.skipped[1]).toMatchObject({
      reason: 'invalid-signature',
      provider: 'github',
      timestamp: 3,
    });
    expect(body.skipped[2]).toMatchObject({ reason: 'duplicate', contextId: 'SPE-2' });
    expect(body.skipped[3]).toMatchObject({ reason: 'no-routing-match', contextId: 'SPE-1' });
  });

  it('clamps the ?limit= query parameter to [0, server-cap]', async () => {
    getSkippedWebhooksRegistry();
    const bus = getEventBus();
    for (let i = 0; i < 5; i += 1) {
      bus.publish({
        type: 'webhook.rejected',
        timestamp: i,
        traceId: `t-${i}`,
        provider: 'jira',
        reason: 'no-routing-match',
      });
    }

    const limited = await fetch(`${baseUrl}/api/webhooks/skipped/recent?limit=2`);
    const body = (await limited.json()) as SkippedResponseBody;
    expect(body.skipped).toHaveLength(2);

    const huge = await fetch(`${baseUrl}/api/webhooks/skipped/recent?limit=10000`);
    const hugeBody = (await huge.json()) as SkippedResponseBody;
    // Server-cap is 100; we only published 5, so we get 5 back.
    expect(hugeBody.skipped).toHaveLength(5);

    const negative = await fetch(`${baseUrl}/api/webhooks/skipped/recent?limit=-3`);
    const negativeBody = (await negative.json()) as SkippedResponseBody;
    expect(negativeBody.skipped).toHaveLength(0);

    // Garbage non-numeric falls through to the default (50).
    const garbage = await fetch(`${baseUrl}/api/webhooks/skipped/recent?limit=banana`);
    const garbageBody = (await garbage.json()) as SkippedResponseBody;
    expect(garbageBody.skipped).toHaveLength(5);
  });
});
