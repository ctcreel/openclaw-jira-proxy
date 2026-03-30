/**
 * End-to-end integration test: webhook HTTP → HMAC → BullMQ → worker → gateway HTTP POST
 *
 * Mocked: OpenClaw gateway (simple HTTP server accepting POST /hooks/agent)
 * Real: Express app, HMAC validation, BullMQ queue + worker
 *
 * Simulates webhook payloads from Jira, GitHub, and Linear hitting HTTP endpoints
 * and verifies the full chain through to gateway delivery.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

import { vi } from 'vitest';
import { resetSettings } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';

vi.mock('../../src/services/session-monitor.service', () => ({
  waitForSessionIdle: vi.fn().mockResolvedValue(undefined),
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

// -- Sample payloads --
const JIRA_PAYLOAD = JSON.stringify({
  webhookEvent: 'jira:issue_updated',
  issue: {
    key: 'SPE-1567',
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

const GITHUB_PAYLOAD = JSON.stringify({
  action: 'submitted',
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

const LINEAR_PAYLOAD = JSON.stringify({
  action: 'update',
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

// -- HMAC helpers --
function signWebSub(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function signGitHub(payload: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

// -- Mock Gateway (HTTP) --
interface DeliveredPayload {
  body: string;
  authHeader: string;
  receivedAt: string;
}

function createMockGateway(): {
  server: Server;
  deliveries: DeliveredPayload[];
  getPort: () => number;
} {
  const deliveries: DeliveredPayload[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/hooks/agent') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        deliveries.push({
          body: Buffer.concat(chunks).toString(),
          authHeader: req.headers.authorization ?? '',
          receivedAt: new Date().toISOString(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, runId: `run-${deliveries.length}` }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(0);

  return {
    server,
    deliveries,
    getPort: () => (server.address() as AddressInfo).port,
  };
}

// -- Helpers --
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDeliveries(
  deliveries: DeliveredPayload[],
  count: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (deliveries.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${count} deliveries (got ${deliveries.length})`);
    }
    await sleep(100);
  }
}

// -- Test suite --
describe('E2E: webhook → queue → gateway HTTP delivery', () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let app: import('express').Express;
  let workers: Array<import('bullmq').Worker>;

  beforeAll(async () => {
    gateway = createMockGateway();

    process.env.OPENCLAW_TOKEN = 'e2e-test-token';
    process.env.OPENCLAW_HOOK_URL = `http://127.0.0.1:${gateway.getPort()}/hooks/agent`;
    process.env.PROVIDERS_CONFIG = JSON.stringify(TEST_PROVIDERS);
    resetSettings();
    resetQueues();

    // Flush stale completed/failed jobs from previous runs so content-hash dedup works
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const flushConn = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    for (const p of TEST_PROVIDERS) {
      const q = new Queue(`webhooks-${p.name}`, { connection: flushConn });
      await q.drain(true); // remove delayed jobs
      // Remove completed/failed to reset dedup
      const completed = await q.getCompleted(0, 1000);
      const failed = await q.getFailed(0, 1000);
      for (const job of [...completed, ...failed]) {
        await job.remove();
      }
      await q.close();
    }
    await flushConn.quit();

    const { createApp } = await import('../../src/app');
    app = createApp();

    const { createWorker } = await import('../../src/services/worker.service');
    const { getSettings } = await import('../../src/config');

    const settings = getSettings();
    workers = settings.providers.map((p) => createWorker(p));

    // Wait for workers to fully connect and drain any stale jobs before tests run
    await sleep(2000);
    gateway.deliveries.length = 0;
  });

  beforeEach(async () => {
    process.env.OPENCLAW_TOKEN = 'e2e-test-token';
    process.env.OPENCLAW_HOOK_URL = `http://127.0.0.1:${gateway.getPort()}/hooks/agent`;
    process.env.PROVIDERS_CONFIG = JSON.stringify(TEST_PROVIDERS);
    gateway.deliveries.length = 0;

    // Remove completed/failed jobs between tests so content-hash dedup doesn't skip re-enqueues
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const conn = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    for (const p of TEST_PROVIDERS) {
      const q = new Queue(`webhooks-${p.name}`, { connection: conn });
      const completed = await q.getCompleted(0, 1000);
      const failed = await q.getFailed(0, 1000);
      for (const job of [...completed, ...failed]) {
        await job.remove();
      }
      await q.close();
    }
    await conn.quit();
  });

  afterAll(async () => {
    if (workers) await Promise.all(workers.map((w) => w.close()));
    await new Promise<void>((resolve, reject) => {
      gateway.server.close((err) => (err ? reject(err) : resolve()));
    });
    resetSettings();
    resetQueues();
  });

  // --- Jira ---

  it('should accept a Jira webhook and deliver to gateway', { timeout: 15_000 }, async () => {
    const res = await request(app)
      .post('/hooks/jira')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(JIRA_PAYLOAD, JIRA_SECRET))
      .send(JIRA_PAYLOAD);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });

    await waitForDeliveries(gateway.deliveries, 1, 12000);

    expect(gateway.deliveries).toHaveLength(1);
    const [delivery] = gateway.deliveries;
    expect(delivery.authHeader).toBe('Bearer e2e-test-token');

    const envelope = JSON.parse(delivery.body);
    const forwarded = JSON.parse(envelope.message);
    expect(forwarded.issue.key).toBe('SPE-1567');
    expect(forwarded.webhookEvent).toBe('jira:issue_updated');
  });

  // --- GitHub ---

  it('should accept a GitHub webhook with X-Hub-Signature-256', async () => {
    const res = await request(app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signGitHub(GITHUB_PAYLOAD, GITHUB_SECRET))
      .send(GITHUB_PAYLOAD);

    expect(res.status).toBe(202);

    await waitForDeliveries(gateway.deliveries, 1, 5000);

    const envelope = JSON.parse(gateway.deliveries[0].body);
    const forwarded = JSON.parse(envelope.message);
    expect(forwarded.action).toBe('submitted');
    expect(forwarded.pull_request.number).toBe(1053);
    expect(forwarded.repository.full_name).toBe('SC0RED/Platform-Frontend');
  });

  // --- Linear ---

  it('should accept a Linear webhook (websub strategy)', async () => {
    const res = await request(app)
      .post('/hooks/linear')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(LINEAR_PAYLOAD, LINEAR_SECRET))
      .send(LINEAR_PAYLOAD);

    expect(res.status).toBe(202);

    await waitForDeliveries(gateway.deliveries, 1, 5000);

    const envelope = JSON.parse(gateway.deliveries[0].body);
    const forwarded = JSON.parse(envelope.message);
    expect(forwarded.data.identifier).toBe('ENG-42');
  });

  // --- Security ---

  it('should reject a webhook with invalid HMAC signature', async () => {
    const res = await request(app)
      .post('/hooks/jira')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signWebSub(JIRA_PAYLOAD, 'wrong-secret'))
      .send(JIRA_PAYLOAD);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });

    await sleep(200);
    expect(gateway.deliveries).toHaveLength(0);
  });

  it('should reject a webhook with missing signature header', async () => {
    const res = await request(app)
      .post('/hooks/github')
      .set('Content-Type', 'application/json')
      .send(GITHUB_PAYLOAD);

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

  it('should process webhooks from multiple providers', async () => {
    const [jiraRes, githubRes, linearRes] = await Promise.all([
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(JIRA_PAYLOAD, JIRA_SECRET))
        .send(JIRA_PAYLOAD),
      request(app)
        .post('/hooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signGitHub(GITHUB_PAYLOAD, GITHUB_SECRET))
        .send(GITHUB_PAYLOAD),
      request(app)
        .post('/hooks/linear')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(LINEAR_PAYLOAD, LINEAR_SECRET))
        .send(LINEAR_PAYLOAD),
    ]);

    expect(jiraRes.status).toBe(202);
    expect(githubRes.status).toBe(202);
    expect(linearRes.status).toBe(202);

    await waitForDeliveries(gateway.deliveries, 3, 10000);
    expect(gateway.deliveries).toHaveLength(3);
  });

  // --- Serialization ---

  it('should serialize multiple webhooks from the same provider', async () => {
    const payload2 = JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue: {
        key: 'SPE-1593',
        fields: {
          summary: 'Checkbox un-check bug',
          status: { name: 'In Development' },
          assignee: { displayName: 'Patches' },
          priority: { name: 'High' },
          issuetype: { name: 'Bug' },
        },
      },
      changelog: { items: [{ field: 'status', fromString: 'Plan', toString: 'In Development' }] },
    });

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(JIRA_PAYLOAD, JIRA_SECRET))
        .send(JIRA_PAYLOAD),
      request(app)
        .post('/hooks/jira')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature', signWebSub(payload2, JIRA_SECRET))
        .send(payload2),
    ]);

    expect(res1.status).toBe(202);
    expect(res2.status).toBe(202);

    await waitForDeliveries(gateway.deliveries, 2, 10000);
    expect(gateway.deliveries).toHaveLength(2);

    // Verify ordering — second delivery happened after first
    const [first, second] = gateway.deliveries;
    expect(new Date(first.receivedAt).getTime()).toBeLessThanOrEqual(
      new Date(second.receivedAt).getTime(),
    );
  });
});
