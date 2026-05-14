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
import type { Worker as BullMQWorker } from 'bullmq';
import request from 'supertest';

import { resetSettings } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';
import { registerRunner, resetRunners } from '../../src/runners/registry';
import type { AgentRunner, RunOptions, RunResult } from '../../src/runners/types';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';

const VALID_TOKEN = 'integration-bearer-token-builder-callback';

interface DeliveredPayload {
  prompt: string;
  agentId: string;
  receivedAt: string;
}

const allDeliveries: DeliveredPayload[] = [];

class CapturingRunner implements AgentRunner {
  readonly name = 'openclaw';

  async run(options: RunOptions): Promise<RunResult> {
    allDeliveries.push({
      prompt: options.prompt,
      agentId: options.agentId,
      receivedAt: new Date().toISOString(),
    });
    return {
      status: 'ok',
      runId: `mock-callback-run-${Date.now()}`,
      renderedPrompt: options.prompt,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let currentTestId = '';
let testCounter = 0;
function nextTestId(): string {
  return `callback-test-${Date.now()}-${++testCounter}`;
}

function deliveriesForCurrentTest(): DeliveredPayload[] {
  return allDeliveries.filter((delivery) => delivery.prompt.includes(currentTestId));
}

async function waitForDeliveries(count: number, timeoutMs = 8000): Promise<DeliveredPayload[]> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const matched = deliveriesForCurrentTest();
    if (matched.length >= count) return matched;
    await sleep(50);
  }
  const finalMatched = deliveriesForCurrentTest();
  if (finalMatched.length >= count) return finalMatched;
  throw new Error(`Timed out waiting for ${count} deliveries (got ${finalMatched.length})`);
}

/**
 * Fake dispatching agent (stand-in for Winston). Created with a real
 * on-disk template file so the worker's template renderer can resolve
 * `messageTemplate` paths. Mirrors the shape an opted-in agent would
 * declare per `docs/builder-onboarding.md` step 2.5.
 */
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
              condition: {
                all_of: [{ equals: { field: 'agentName', value: 'winston' } }],
              },
              messageTemplate: TEMPLATE_RELATIVE_PATH,
            },
          ],
        },
      },
      modelRules: {},
    },
  };
}

describe('Builder callback integration', () => {
  let app: Express;
  let workers: BullMQWorker[] = [];
  let queueNames: string[] = [];

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

    resetRunners();
    registerRunner(new CapturingRunner());

    const agent = buildFakeDispatchingAgent();
    const { createApp } = await import('../../src/app');
    app = createApp([agent]);

    const { createWorker } = await import('../../src/services/worker.service');
    const { buildQueueName } = await import('../../src/services/queue.service');
    const { getSettings } = await import('../../src/config');
    const providers = getSettings().providers;
    workers = providers.map((provider) => createWorker({ provider, agents: [agent] }));
    queueNames = providers.map((provider) => buildQueueName(provider.name));

    await sleep(500);
  }, 30_000);

  beforeEach(() => {
    currentTestId = nextTestId();
    resetRunners();
    registerRunner(new CapturingRunner());
  });

  afterAll(async () => {
    for (const worker of workers) await worker.close();

    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const connection = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    for (const queueName of queueNames) {
      const queue = new Queue(queueName, { connection });
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await connection.quit();

    delete process.env.BULLMQ_QUEUE_PREFIX;
    delete process.env.PROVIDERS_CONFIG;
    resetSettings();
    resetQueues();
    resetRunners();

    if (agentTempDir) await rm(agentTempDir, { recursive: true, force: true });
  });

  it('a working callback routes to the dispatching agent and reaches its runner', async () => {
    const callback = {
      eventId: `job-${currentTestId}:working`,
      state: 'working',
      agentName: 'winston',
      replyContext: {
        channel: 'slack',
        threadTs: '1700000000.000300',
        channelId: 'C0123456',
        senderId: 'heather@example.com',
        originalRequestText: `request marker ${currentTestId}`,
      },
    };

    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(callback);

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);

    const deliveries = await waitForDeliveries(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.agentId).toBe('winston');
  }, 15_000);

  it('a question_pending callback routes to the dispatching agent', async () => {
    const callback = {
      eventId: `job-${currentTestId}:question_pending`,
      state: 'question_pending',
      agentName: 'winston',
      question: 'Slack-only or email too?',
      branch: 'builder/onboarding-helper',
      planPath: '.builder/plan.md',
      replyContext: {
        channel: 'slack',
        threadTs: '1700000000.000400',
        channelId: 'C0123456',
        senderId: 'heather@example.com',
        originalRequestText: `qp marker ${currentTestId}`,
      },
    };

    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(callback);

    expect(response.status).toBe(202);
    const deliveries = await waitForDeliveries(1);
    expect(deliveries[0]!.agentId).toBe('winston');
  }, 15_000);

  it('a testable callback routes to the dispatching agent', async () => {
    const callback = {
      eventId: `job-${currentTestId}:testable`,
      state: 'testable',
      agentName: 'winston',
      prUrl: 'https://github.com/example/repo/pull/123',
      testUrl: 'https://preview-123.example.com',
      replyContext: {
        channel: 'slack',
        threadTs: '1700000000.000500',
        channelId: 'C0123456',
        senderId: 'heather@example.com',
        originalRequestText: `testable marker ${currentTestId}`,
      },
    };

    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(callback);

    expect(response.status).toBe(202);
    const deliveries = await waitForDeliveries(1);
    expect(deliveries[0]!.agentId).toBe('winston');
  }, 15_000);

  it('rejects callback with wrong bearer (401) and no delivery happens', async () => {
    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', 'Bearer wrong-token')
      .set('Content-Type', 'application/json')
      .send({
        eventId: `job-${currentTestId}:working`,
        state: 'working',
        agentName: 'winston',
        replyContext: { channel: 'slack', marker: currentTestId },
      });

    expect(response.status).toBe(401);
    await sleep(200);
    expect(deliveriesForCurrentTest()).toHaveLength(0);
  }, 10_000);

  it('skips callbacks targeting an unknown agentName (no delivery, no error)', async () => {
    const callback = {
      eventId: `job-${currentTestId}:working`,
      state: 'working',
      agentName: 'not-an-agent',
      replyContext: {
        channel: 'slack',
        threadTs: '1700000000.000600',
        channelId: 'C0123456',
        senderId: 'heather@example.com',
        originalRequestText: `unknown marker ${currentTestId}`,
      },
    };

    const response = await request(app)
      .post('/webhooks/builder-callback')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(callback);

    expect(response.status).toBe(202);
    await sleep(500);
    expect(deliveriesForCurrentTest()).toHaveLength(0);
  }, 10_000);
});
