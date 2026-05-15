/**
 * End-to-end integration test for Builder's dispatch route:
 *   POST /webhooks/system/builder
 *     → bearer validation
 *     → webhook ingestion + BullMQ enqueue
 *     → worker pickup
 *     → runner.run with Builder's rendered prompt
 *
 * Mocked: Runner (capturing), SecretManager (stub returning the test bearer).
 * Real: Express app, signature validation, BullMQ queue + worker, Redis.
 *
 * Requires: redis-server running at REDIS_URL (default 127.0.0.1:6379).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

import { resetSettings } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';
import type * as SecretsManagerModule from '../../src/secrets/manager';
import {
  type BuilderWorkerSet,
  clearWebhookDedupKeys,
  getDeliveriesMatching,
  installCapturingRunner,
  nextTestMarker,
  sleep,
  startBuilderTestWorkers,
  stopBuilderTestWorkers,
  waitForDeliveries,
} from './helpers/builder-test-harness';

const VALID_TOKEN = 'integration-bearer-token-builder-dispatch';

interface FakeSecretManager {
  hasSecret: (key: string) => boolean;
  getSecret: (key: string) => string;
}

vi.mock('../../src/secrets/manager', async () => {
  const actual = await vi.importActual<typeof SecretsManagerModule>('../../src/secrets/manager');
  return {
    ...actual,
    getSecretManager: (): FakeSecretManager => ({
      hasSecret: (key: string): boolean => key === 'builder_internal_bearer',
      getSecret: (key: string): string => {
        if (key !== 'builder_internal_bearer') {
          throw new Error(`Unexpected secret key: ${key}`);
        }
        return VALID_TOKEN;
      },
    }),
  };
});

// This test exercises routing + worker pickup + runner dispatch only.
// Builder's `handle-dispatch` rule now declares
// `tools: [agency_tools.clawndom.fire_builder_callback]`, which the
// worker would try to materialize via Python's import machinery in
// `buildMCPBundle`. CI runners (and dev machines without an editable
// agency-tools install) can't resolve that, and the runner stub here
// doesn't exercise the tool surface anyway. Stub the bundle to skip
// the real lookup — the tool-resolution path has its own dedicated
// tests under `tests/services/tools/`.
vi.mock('../../src/services/tools/load-for-run', () => ({
  buildMCPBundle: vi.fn().mockResolvedValue(undefined),
  cleanupMCPBundle: vi.fn().mockResolvedValue(undefined),
}));

describe('Builder dispatch integration', () => {
  let app: Express;
  let workerSet: BuilderWorkerSet;
  let currentMarker = '';

  beforeAll(async () => {
    process.env.BULLMQ_QUEUE_PREFIX = `test-builder-${Date.now()}`;
    process.env.PROVIDERS_CONFIG = JSON.stringify([
      {
        name: 'builder-dispatch',
        transport: 'webhook',
        routePath: '/webhooks/system/builder',
        signatureStrategy: 'bearer',
        hmacSecret: VALID_TOKEN,
      },
    ]);
    resetSettings();
    resetQueues();
    installCapturingRunner();

    const { loadSystemAgents } = await import('../../src/system-agents/loader');
    const systemAgents = await loadSystemAgents();

    const { createApp } = await import('../../src/app');
    app = createApp(systemAgents);

    workerSet = await startBuilderTestWorkers(systemAgents);

    await sleep(500);
  }, 30_000);

  beforeEach(async () => {
    currentMarker = nextTestMarker('dispatch-test');
    installCapturingRunner();
    await clearWebhookDedupKeys();
  });

  afterAll(async () => {
    await stopBuilderTestWorkers(workerSet);
  });

  it('accepts a valid dispatch (202) and delivers a rendered prompt to the runner', async () => {
    const payload = {
      agentName: 'winston',
      request: `Please add an onboarding helper for ${currentMarker}`,
      replyContext: {
        channel: 'slack',
        threadTs: '1700000000.000100',
        channelId: 'C0123456',
        senderEmail: 'heather@example.com',
        originalRequestText: 'Help with onboarding',
      },
      senderEmail: 'heather@example.com',
    };

    const response = await request(app)
      .post('/webhooks/system/builder')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);

    const deliveries = await waitForDeliveries(currentMarker, 1);
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(delivery!.agentId).toBe('builder');
    expect(delivery!.prompt).toContain('winston');
    expect(delivery!.prompt).toContain(`add an onboarding helper for ${currentMarker}`);
    expect(delivery!.prompt).toContain('heather@example.com');
  }, 15_000);

  it('rejects a dispatch with the wrong bearer (401)', async () => {
    const response = await request(app)
      .post('/webhooks/system/builder')
      .set('Authorization', 'Bearer wrong-token')
      .set('Content-Type', 'application/json')
      .send({ marker: currentMarker });

    expect(response.status).toBe(401);
    await sleep(200);
    expect(getDeliveriesMatching(currentMarker)).toHaveLength(0);
  }, 10_000);

  it('rejects a dispatch with no Authorization header (401)', async () => {
    const response = await request(app)
      .post('/webhooks/system/builder')
      .set('Content-Type', 'application/json')
      .send({ marker: currentMarker });

    expect(response.status).toBe(401);
    await sleep(200);
    expect(getDeliveriesMatching(currentMarker)).toHaveLength(0);
  }, 10_000);

  it('renders the resume section when resume is present in the dispatch', async () => {
    const payload = {
      agentName: 'winston',
      request: `Resume integration test ${currentMarker}`,
      replyContext: {
        channel: 'slack',
        threadTs: '1700000000.000200',
        channelId: 'C0123456',
        senderEmail: 'heather@example.com',
        originalRequestText: 'Resume test',
      },
      senderEmail: 'heather@example.com',
      resume: {
        branch: 'builder/resume-fixture',
        answer: 'Yes, Slack only.',
      },
    };

    const response = await request(app)
      .post('/webhooks/system/builder')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).toBe(202);

    const deliveries = await waitForDeliveries(currentMarker, 1);
    const [delivery] = deliveries;
    expect(delivery!.prompt).toContain('Resume context');
    expect(delivery!.prompt).toContain('builder/resume-fixture');
    expect(delivery!.prompt).toContain('Yes, Slack only.');
  }, 15_000);
});
