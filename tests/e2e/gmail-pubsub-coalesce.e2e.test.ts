/**
 * E2E smoke test for bug shape #3 — gmail-pubsub coalescer.
 *
 * Gmail's watch fires a Pub/Sub notification every time the watched
 * mailbox changes — including label changes Winston himself causes
 * during triage. Without coalescing, each notification re-enqueues
 * another triage, the queue self-feeds, and a single inbound mail can
 * burn dozens of LLM runs before the inbox stabilises.
 *
 * The ingest pipeline dedups on `provider:contextId:status`. For
 * gmail-pubsub, the context strategy must return `emailAddress` as the
 * id — same mailbox within 60s collapses to one job, the rest land at
 * 202 `accepted: true, duplicate: true`. The production bug was that
 * the strategy returned `?` (no contextStrategy registered for the
 * provider), which sets the dedup id to `?` for every notification and
 * `event-ingest.service` skips the dedup write entirely for an unknown
 * id. The cascade went unblocked.
 *
 * This test fires two POSTs against `/hooks/gmail-pubsub` with the
 * same `emailAddress` and different `historyId` values within the
 * dedup window, asserts the first lands accepted and the second lands
 * accepted-but-duplicate.
 *
 * Requires: redis-server running at REDIS_URL (default 127.0.0.1:6379).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';

import type { ResolvedAgent } from '../../src/services/agent-loader.service';
import {
  buildInternalRuleAgent,
  clearDedupKeys,
  createE2ETestContext,
  type E2ETestContext,
  type E2EWorkerSet,
  fireWebhook,
  installCapturingRunners,
  startE2EApp,
  stopE2EApp,
} from './_dispatch-chain-harness';

const PROVIDER_SECRET = 'gmail-pubsub-e2e-bearer';

describe('e2e: gmail-pubsub coalescer drops second notification within dedup window', () => {
  let app: Express;
  let workerSet: E2EWorkerSet;
  let context: E2ETestContext;
  let teardownContext: () => Promise<void>;
  let teardownAgent: () => Promise<void>;
  let fixtureAgent: ResolvedAgent;

  beforeAll(async () => {
    ({ context, cleanup: teardownContext } = await createE2ETestContext('gmail-pubsub'));

    // Synthesized triage agent. The catch-all condition on
    // routing.gmail-pubsub makes every well-formed Pub/Sub
    // notification eligible to route — the test only cares about the
    // accept/duplicate seam, not what the runner does after pickup.
    ({ agent: fixtureAgent, cleanup: teardownAgent } = await buildInternalRuleAgent({
      agentName: 'winston-gmail-e2e',
      templates: [
        {
          providerBlock: 'gmail-pubsub',
          ruleName: 'triage-inbox',
          templateSource: 'Triage notification received for {{ emailAddress }}.',
        },
      ],
    }));

    ({ app, workerSet } = await startE2EApp({
      providersConfig: [
        {
          name: 'gmail-pubsub',
          // Use bearer (not oidc) so the test doesn't have to mock
          // Google's JWKs. Contract under test is the dedup seam, not
          // signature verification — those have dedicated tests.
          signatureStrategy: 'bearer',
          routePath: '/hooks/gmail-pubsub',
          hmacSecret: PROVIDER_SECRET,
          contextStrategy: 'gmail-pubsub',
        },
      ],
      agentToken: context.agentToken,
      queuePrefix: context.queuePrefix,
      auditLogPath: context.auditLogPath,
      fixtureAgents: [fixtureAgent],
    }));
  }, 30_000);

  afterAll(async () => {
    await stopE2EApp(workerSet);
    await teardownAgent();
    await teardownContext();
  });

  beforeEach(async () => {
    installCapturingRunners();
    await clearDedupKeys();
  });

  it('returns accepted: true then accepted+duplicate for the same emailAddress', async () => {
    const emailAddress = 'heather@example.com';
    const headers = { Authorization: `Bearer ${PROVIDER_SECRET}` };

    const first = await fireWebhook(app, {
      route: '/hooks/gmail-pubsub',
      headers,
      payload: { emailAddress, historyId: '1001' },
    });
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ accepted: true });

    // Second notification: SAME emailAddress (so the same dedup key
    // collides), different historyId (proving the dedup keys on the
    // mailbox, not on the history cursor). Fired immediately so it
    // lands well inside the default 60s dedup TTL.
    const second = await fireWebhook(app, {
      route: '/hooks/gmail-pubsub',
      headers,
      payload: { emailAddress, historyId: '1002' },
    });
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ accepted: true, duplicate: true });
  }, 15_000);

  it('does NOT dedup notifications for different mailboxes', async () => {
    const headers = { Authorization: `Bearer ${PROVIDER_SECRET}` };

    const heather = await fireWebhook(app, {
      route: '/hooks/gmail-pubsub',
      headers,
      payload: { emailAddress: 'heather@example.com', historyId: '2001' },
    });
    const tom = await fireWebhook(app, {
      route: '/hooks/gmail-pubsub',
      headers,
      payload: { emailAddress: 'tom@example.com', historyId: '2002' },
    });

    expect(heather.status).toBe(202);
    expect(heather.body).toEqual({ accepted: true });
    expect(tom.status).toBe(202);
    expect(tom.body).toEqual({ accepted: true });
  }, 15_000);
});
