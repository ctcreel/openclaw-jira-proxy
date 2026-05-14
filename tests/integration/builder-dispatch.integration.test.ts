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
import type { Worker as BullMQWorker } from 'bullmq';
import request from 'supertest';

import { resetSettings } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';
import { registerRunner, resetRunners } from '../../src/runners/registry';
import type { AgentRunner, RunOptions, RunResult } from '../../src/runners/types';
import type * as SecretsManagerModule from '../../src/secrets/manager';

const VALID_TOKEN = 'integration-bearer-token-builder-dispatch';

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
      runId: `mock-builder-run-${Date.now()}`,
      renderedPrompt: options.prompt,
    };
  }
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let currentTestId = '';
let testCounter = 0;
function nextTestId(): string {
  return `dispatch-test-${Date.now()}-${++testCounter}`;
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

describe('Builder dispatch integration', () => {
  let app: Express;
  let workers: BullMQWorker[] = [];
  let queueNames: string[] = [];

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

    resetRunners();
    registerRunner(new CapturingRunner());

    const { loadSystemAgents } = await import('../../src/system-agents/loader');
    const systemAgents = await loadSystemAgents();

    const { createApp } = await import('../../src/app');
    app = createApp(systemAgents);

    const { createWorker } = await import('../../src/services/worker.service');
    const { buildQueueName } = await import('../../src/services/queue.service');
    const { getSettings } = await import('../../src/config');
    const providers = getSettings().providers;
    workers = providers.map((provider) => createWorker({ provider, agents: systemAgents }));
    queueNames = providers.map((provider) => buildQueueName(provider.name));

    await sleep(500);
  }, 30_000);

  beforeEach(() => {
    currentTestId = nextTestId();
    // Global setup.ts runs resetRunners() in its own beforeEach, so we
    // have to re-register the capturing runner before each test.
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
  });

  it('accepts a valid dispatch (202) and delivers a rendered prompt to the runner', async () => {
    const payload = {
      agentName: 'winston',
      request: `Please add an onboarding helper for ${currentTestId}`,
      replyContext: {
        channel: 'slack',
        threadTs: '1700000000.000100',
        channelId: 'C0123456',
        senderId: 'heather@example.com',
        originalRequestText: 'Help with onboarding',
      },
      senderIdentity: 'heather@example.com',
    };

    const response = await request(app)
      .post('/webhooks/system/builder')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);

    const deliveries = await waitForDeliveries(1);
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(delivery!.agentId).toBe('builder');
    expect(delivery!.prompt).toContain('winston');
    expect(delivery!.prompt).toContain(`add an onboarding helper for ${currentTestId}`);
    expect(delivery!.prompt).toContain('heather@example.com');
  }, 15_000);

  it('rejects a dispatch with the wrong bearer (401)', async () => {
    const response = await request(app)
      .post('/webhooks/system/builder')
      .set('Authorization', 'Bearer wrong-token')
      .set('Content-Type', 'application/json')
      .send({ marker: currentTestId });

    expect(response.status).toBe(401);
    await sleep(200);
    expect(deliveriesForCurrentTest()).toHaveLength(0);
  }, 10_000);

  it('rejects a dispatch with no Authorization header (401)', async () => {
    const response = await request(app)
      .post('/webhooks/system/builder')
      .set('Content-Type', 'application/json')
      .send({ marker: currentTestId });

    expect(response.status).toBe(401);
    await sleep(200);
    expect(deliveriesForCurrentTest()).toHaveLength(0);
  }, 10_000);

  it('renders the resume section when resume is present in the dispatch', async () => {
    const payload = {
      agentName: 'winston',
      request: `Resume integration test ${currentTestId}`,
      replyContext: {
        channel: 'slack',
        threadTs: '1700000000.000200',
        channelId: 'C0123456',
        senderId: 'heather@example.com',
        originalRequestText: 'Resume test',
      },
      senderIdentity: 'heather@example.com',
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

    const deliveries = await waitForDeliveries(1);
    const [delivery] = deliveries;
    expect(delivery!.prompt).toContain('Resume context');
    expect(delivery!.prompt).toContain('builder/resume-fixture');
    expect(delivery!.prompt).toContain('Yes, Slack only.');
  }, 15_000);
});
