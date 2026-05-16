/**
 * End-to-end integration test for Builder's callback route:
 *   Builder POSTs lifecycle state to /webhooks/builder-callback
 *     → bearer validation
 *     → webhook ingestion + BullMQ enqueue
 *     → worker pickup
 *     → routes to a dispatching agent's `routing.builder-callback` rule
 *     → that agent's rendered template reaches its runner
 *
 * This is the fan-out path that delivers Builder's `working`/
 * `question_pending`/`testable`/`failed` events back into the
 * conversation. Mocked: Runner (capturing). Real: Express app,
 * signature validation, BullMQ queue + worker, Redis, fake
 * dispatching agent with routing.builder-callback rules.
 *
 * Requires: redis-server running at REDIS_URL (default 127.0.0.1:6379).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import request from 'supertest';

import { resetSettings } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';
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

const VALID_TOKEN = 'integration-bearer-token-builder-callback';

let agentTempDir = '';
const TEMPLATE_RELATIVE_PATH = 'templates/builder-callback-reply.njk';
const TEMPLATE_BODY =
  'BUILDER_CALLBACK_REPLY agentName={{ agentName }} state={{ state }} marker={{ replyContext.originalRequestText }}';

function buildFakeDispatchingAgent(): ResolvedAgent {
  return {
    name: 'winston',
    dir: agentTempDir,
    config: {
      routing: {
        'builder-callback': {
          rules: [
            {
              name: 'reply-to-operator',
              condition: { all_of: [{ equals: { field: 'agentName', value: 'winston' } }] },
              messageTemplate: TEMPLATE_RELATIVE_PATH,
            },
          ],
        },
      },
      modelRules: {},
    },
  };
}

interface CallbackPayload {
  eventId: string;
  state: string;
  agentName: string;
  replyContext: {
    channel: string;
    threadTs?: string;
    channelId?: string;
    senderEmail: string;
    originalRequestText: string;
  };
  question?: string;
  prUrl?: string;
  testUrl?: string;
}

function buildCallback(
  state: string,
  marker: string,
  extras: Partial<CallbackPayload> = {},
): CallbackPayload {
  return {
    eventId: `job-${marker}:${state}`,
    state,
    agentName: 'winston',
    replyContext: {
      channel: 'slack',
      threadTs: '1700000000.000000',
      channelId: 'C0123456',
      senderEmail: 'heather@example.com',
      originalRequestText: `${state}-marker ${marker}`,
    },
    ...extras,
  };
}

describe('Builder callback integration', () => {
  let app: Express;
  let workerSet: BuilderWorkerSet;
  let currentMarker = '';

  beforeAll(async () => {
    agentTempDir = await mkdtemp(join(tmpdir(), 'builder-callback-test-agent-'));
    await mkdir(join(agentTempDir, 'templates'), { recursive: true });
    await writeFile(join(agentTempDir, TEMPLATE_RELATIVE_PATH), TEMPLATE_BODY, 'utf-8');

    process.env.BULLMQ_QUEUE_PREFIX = `test-callback-${Date.now()}`;
    process.env.PROVIDERS_CONFIG = JSON.stringify([
      {
        name: 'builder-callback',
        transport: 'webhook',
        routePath: '/webhooks/builder-callback',
        signatureStrategy: 'bearer',
        hmacSecret: VALID_TOKEN,
      },
    ]);
    resetSettings();
    resetQueues();
    installCapturingRunner();

    const agent = buildFakeDispatchingAgent();
    const { createApp } = await import('../../src/app');
    app = createApp([agent]);

    workerSet = await startBuilderTestWorkers([agent]);

    await sleep(500);
  }, 30_000);

  beforeEach(async () => {
    currentMarker = nextTestMarker('callback-test');
    installCapturingRunner();
    await clearWebhookDedupKeys();
  });

  afterAll(async () => {
    await stopBuilderTestWorkers(workerSet);
    if (agentTempDir) await rm(agentTempDir, { recursive: true, force: true });
  });

  it('a working callback routes to the dispatching agent and reaches its runner', async () => {
    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(buildCallback('working', currentMarker));

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);

    const deliveries = await waitForDeliveries(currentMarker, 1);
    expect(deliveries[0]!.agentId).toBe('winston');
  }, 15_000);

  it('a question_pending callback routes to the dispatching agent', async () => {
    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(
        buildCallback('question_pending', currentMarker, {
          question: 'Slack-only or email too?',
          prUrl: 'https://github.com/org/the-agency/pull/42',
        }),
      );

    expect(response.status).toBe(202);
    const deliveries = await waitForDeliveries(currentMarker, 1);
    expect(deliveries[0]!.agentId).toBe('winston');
  }, 15_000);

  it('a testable callback routes to the dispatching agent', async () => {
    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(
        buildCallback('testable', currentMarker, {
          prUrl: 'https://github.com/example/repo/pull/123',
          testUrl: 'https://preview-123.example.com',
        }),
      );

    expect(response.status).toBe(202);
    const deliveries = await waitForDeliveries(currentMarker, 1);
    expect(deliveries[0]!.agentId).toBe('winston');
  }, 15_000);

  it('rejects callback with wrong bearer (401) and no delivery happens', async () => {
    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', 'Bearer wrong-token')
      .set('Content-Type', 'application/json')
      .send(buildCallback('working', currentMarker));

    expect(response.status).toBe(401);
    await sleep(200);
    expect(getDeliveriesMatching(currentMarker)).toHaveLength(0);
  }, 10_000);

  it('skips callbacks targeting an unknown agentName (no delivery, no error)', async () => {
    const callback = buildCallback('working', currentMarker, { agentName: 'not-an-agent' });

    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(callback);

    expect(response.status).toBe(202);
    await sleep(500);
    expect(getDeliveriesMatching(currentMarker)).toHaveLength(0);
  }, 10_000);
});
