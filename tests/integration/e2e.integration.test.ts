/**
 * End-to-end integration test: webhook HTTP → HMAC → BullMQ → worker → GatewayClient.runAndWait
 *
 * Mocked: GatewayClient (runAndWait) — captures deliveries synchronously, no WS connection
 * Real: Express app, HMAC validation, BullMQ queue + worker
 *
 * Each test uses a unique test ID to isolate its deliveries from other tests
 * running against the same shared workers and queues.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import request from 'supertest';

import { vi } from 'vitest';
import { resetSettings } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';
import type { AgentRunResult } from '../../src/services/gateway-client';

// -- Delivery capture --
interface DeliveredPayload {
  message: string;
  sessionKey: string;
  agentId?: string;
  model?: string;
  receivedAt: string;
}

/**
 * Global deliveries array shared across all tests. Each test filters by its
 * own testId rather than resetting the array — avoids the BullMQ race
 * condition where draining queues between tests causes workers to miss
 * job pickup signals.
 */
const allDeliveries: DeliveredPayload[] = [];

const { mockRunAndWait } = vi.hoisted(() => ({
  mockRunAndWait: vi.fn(),
}));

vi.mock('../../src/services/gateway-client', () => ({
  GatewayClient: vi.fn().mockImplementation(() => ({
    runAndWait: mockRunAndWait,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// -- Secrets --
const JIRA_SECRET = 'jira-test-hmac-secret-1234';
const GITHUB_SECRET = 'github-test-hmac-secret-5678';
const LINEAR_SECRET = 'linear-test-hmac-secret-9012';

// -- Provider config --
const TEST_PROVIDERS = [
  {
    name: 'jira',
    routePath: '/hooks/jira',
    hmacSecret: JIRA_SECRET,
    signatureStrategy: 'websub',
    openclawHookUrl: 'http://unused',
  },
  {
    name: 'github',
    routePath: '/hooks/github',
    hmacSecret: GITHUB_SECRET,
    signatureStrategy: 'github',
    openclawHookUrl: 'http://unused',
  },
  {
    name: 'linear',
    routePath: '/hooks/linear',
    hmacSecret: LINEAR_SECRET,
    signatureStrategy: 'websub',
    openclawHookUrl: 'http://unused',
  },
];

// -- Unique test IDs --
let _testCounter = 0;
let currentTestId = '';

function nextTestId(): string {
  return `test-${Date.now()}-${++_testCounter}`;
}

// -- Sample payloads --
// Each payload embeds the testId for filtering deliveries per test
function makeJiraPayload(key = 'SPE-1567'): string {
  return JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    _testId: currentTestId,
    issue: {
      key,
      fields: {
        summary: 'Scorecard modal needs Done button',
        status: { name: 'Ready for Development' },
        assignee: { displayName: 'Patches' },
        priority: { name: 'Medium' },
        issuetype: { name: 'Bug' },
      },
    },
    changelog: {
      items: [{ field: 'status', fromString: 'Plan Review', toString: 'Ready for Development' }],
    },
  });
}

function makeGithubPayload(): string {
  return JSON.stringify({
    action: 'submitted',
    _testId: currentTestId,
    review: {
      state: 'changes_requested',
      body: 'Need to handle the edge case when scorecard is empty',
      user: { login: 'scarlett-bot' },
    },
    pull_request: {
      number: 1053,
      title: 'fix(SPE-1567): add Done button to scorecard modal',
      html_url: 'https://github.com/SC0RED/Platform-Frontend/pull/1053',
      head: { ref: 'fix/SPE-1567-scorecard-done-button' },
    },
    repository: { full_name: 'SC0RED/Platform-Frontend' },
  });
}

function makeLinearPayload(): string {
  return JSON.stringify({
    action: 'update',
    _testId: currentTestId,
    type: 'Issue',
    data: {
      id: 'lin-issue-123',
      identifier: 'ENG-42',
      title: 'Refactor auth middleware',
      state: { name: 'In Progress' },
      assignee: { name: 'Patch' },
    },
    updatedFrom: { stateId: 'state-backlog' },
  });
}

// -- HMAC helpers --
function signWebSub(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function signGitHub(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

// -- Polling helper --
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Filter deliveries that belong to the current test by checking the _testId in the message. */
function deliveriesForCurrentTest(): DeliveredPayload[] {
  return allDeliveries.filter((d) => {
    try {
      const parsed = JSON.parse(d.message);
      return parsed._testId === currentTestId;
    } catch {
      return false;
    }
  });
}

async function waitForDeliveries(count: number, timeoutMs = 8000): Promise<DeliveredPayload[]> {
  const start = Date.now();
  while (true) {
    const matched = deliveriesForCurrentTest();
    if (matched.length >= count) {
      return matched;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} deliveries (got ${matched.length})`);
    }
    await sleep(50);
  }
}

function setupMockRunAndWait(): void {
  mockRunAndWait.mockImplementation(
    (params: { message: string; sessionKey?: string; agentId?: string; model?: string }) => {
      allDeliveries.push({
        message: params.message,
        sessionKey: params.sessionKey ?? 'unknown',
        agentId: params.agentId,
        model: params.model,
        receivedAt: new Date().toISOString(),
      });
      const result: AgentRunResult = { runId: `mock-run-${Date.now()}`, status: 'ok' };
      return Promise.resolve(result);
    },
  );
}

// -- Test suite --
describe('E2E: webhook → queue → GatewayClient.runAndWait (mock)', () => {
  let app: import('express').Express;
  let workers: Array<import('bullmq').Worker>;

  beforeAll(async () => {
    // Isolate test queues from production Clawndom workers sharing the same Redis
    process.env.BULLMQ_QUEUE_PREFIX = `test-${Date.now()}`;
    process.env.OPENCLAW_TOKEN = 'e2e-test-token';
    process.env.OPENCLAW_AGENT_ID = 'patch';
    process.env.PROVIDERS_CONFIG = JSON.stringify(TEST_PROVIDERS);
    resetSettings();
    resetQueues();

    setupMockRunAndWait();

    const { createApp } = await import('../../src/app');
    app = createApp();

    const { createWorker } = await import('../../src/services/worker.service');
    const { GatewayClient } = await import('../../src/services/gateway-client');
    const { getSettings } = await import('../../src/config');
    const settings = getSettings();
    const gatewayClient = new GatewayClient('ws://unused', 'unused');
    workers = settings.providers.map((p) => createWorker({ provider: p, gatewayClient }));

    // Let workers connect and settle
    await sleep(500);
  });

  beforeEach(() => {
    // Each test gets a unique ID — no queue draining needed
    currentTestId = nextTestId();
  });

  afterAll(async () => {
    if (workers) await Promise.all(workers.map((w) => w.close()));

    // Clean up test-prefixed queues from Redis
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const { buildQueueName } = await import('../../src/services/queue.service');
    const cleanConn = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    for (const p of TEST_PROVIDERS) {
      const q = new Queue(buildQueueName(p.name), { connection: cleanConn });
      await q.obliterate({ force: true });
      await q.close();
    }
    await cleanConn.quit();

    delete process.env.BULLMQ_QUEUE_PREFIX;
    resetSettings();
    resetQueues();
  });

  // --- Jira ---

  it('should accept a Jira webhook and deliver via runAndWait', { timeout: 15_000 }, async () => {
    const payload = makeJiraPayload();
    const res = await request(app)
      .post('/hooks/jira')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(payload, JIRA_SECRET))
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });

    const deliveries = await waitForDeliveries(1, 8000);

    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    // Isolated session key, not agent:patch:main
    expect(delivery.sessionKey).toMatch(/^hook:jira:/);

    const forwarded = JSON.parse(delivery.message);
    expect(forwarded.issue.key).toBe('SPE-1567');
    expect(forwarded.webhookEvent).toBe('jira:issue_updated');
  });

  // --- GitHub ---

  it('should accept a GitHub webhook with X-Hub-Signature-256', async () => {
    const payload = makeGithubPayload();
    const res = await request(app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signGitHub(payload, GITHUB_SECRET))
      .send(payload);

    expect(res.status).toBe(202);

    const deliveries = await waitForDeliveries(1, 5000);

    const forwarded = JSON.parse(deliveries[0].message);
    expect(forwarded.action).toBe('submitted');
    expect(forwarded.pull_request.number).toBe(1053);
    expect(forwarded.repository.full_name).toBe('SC0RED/Platform-Frontend');
  });

  // --- Linear ---

  it('should accept a Linear webhook (websub strategy)', async () => {
    const payload = makeLinearPayload();
    const res = await request(app)
      .post('/hooks/linear')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(payload, LINEAR_SECRET))
      .send(payload);

    expect(res.status).toBe(202);

    const deliveries = await waitForDeliveries(1, 5000);

    const forwarded = JSON.parse(deliveries[0].message);
    expect(forwarded.data.identifier).toBe('ENG-42');
  });

  // --- Security ---

  it('should reject a webhook with invalid HMAC signature', async () => {
    const payload = makeJiraPayload();
    const res = await request(app)
      .post('/hooks/jira')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(payload, 'wrong-secret'))
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });

    await sleep(500);
    expect(deliveriesForCurrentTest()).toHaveLength(0);
  });

  it('should reject a webhook with missing signature header', async () => {
    const payload = makeGithubPayload();
    const res = await request(app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing signature' });
  });

  it('should return 404 for unconfigured provider routes', async () => {
    const res = await request(app)
      .post('/hooks/stripe')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'sha256=abc123')
      .send('{}');

    expect(res.status).toBe(404);
  });

  // --- Multi-provider ---

  it('should process webhooks from multiple providers', { timeout: 30_000 }, async () => {
    const jiraPayload = makeJiraPayload();
    const githubPayload = makeGithubPayload();
    const linearPayload = makeLinearPayload();

    const [jiraRes, githubRes, linearRes] = await Promise.all([
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(jiraPayload, JIRA_SECRET))
        .send(jiraPayload),
      request(app)
        .post('/hooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signGitHub(githubPayload, GITHUB_SECRET))
        .send(githubPayload),
      request(app)
        .post('/hooks/linear')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(linearPayload, LINEAR_SECRET))
        .send(linearPayload),
    ]);

    expect(jiraRes.status).toBe(202);
    expect(githubRes.status).toBe(202);
    expect(linearRes.status).toBe(202);

    const deliveries = await waitForDeliveries(3, 20000);
    expect(deliveries).toHaveLength(3);
  });

  // --- Serialization ---

  it('should serialize multiple webhooks from the same provider', { timeout: 15_000 }, async () => {
    const payload1 = makeJiraPayload('SPE-1567');
    const payload2 = makeJiraPayload('SPE-1593');

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(payload1, JIRA_SECRET))
        .send(payload1),
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(payload2, JIRA_SECRET))
        .send(payload2),
    ]);

    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);

    const deliveries = await waitForDeliveries(2, 8000);

    expect(deliveries).toHaveLength(2);
    const keys1 = JSON.parse(deliveries[0].message).issue.key;
    const keys2 = JSON.parse(deliveries[1].message).issue.key;
    expect([keys1, keys2].sort()).toEqual(['SPE-1567', 'SPE-1593']);

    // Verify sequential ordering within the same provider queue
    const t1 = new Date(deliveries[0].receivedAt).getTime();
    const t2 = new Date(deliveries[1].receivedAt).getTime();
    expect(t1).toBeLessThanOrEqual(t2);
  });
});
