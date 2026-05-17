/**
 * Shared harness for the e2e dispatch-chain smoke tests.
 *
 * Each smoke test under `tests/e2e/` fires a synthetic webhook (or internal
 * task) through the real Express app + BullMQ worker stack and asserts
 * what lands at the downstream seam: the runner's `RunOptions.prompt`,
 * the tool-executor audit log at `CLAWNDOM_AUDIT_LOG`, and/or the
 * webhook controller's accept/duplicate response.
 *
 * The bugs that motivated this scaffold (template-render no-op,
 * gmail_reply kwarg shadow, gmail-pubsub dedup miss) lived undetected for
 * weeks because nothing exercised the end-to-end seam. The contract here
 * is that adding a new dispatch-chain test should take ~15 lines: build
 * a tiny agent fixture, fire one request, assert one shape.
 *
 * Each test owns its own temp dir + audit log + BullMQ queue prefix +
 * agent token so suites can run in parallel without cross-test bleed.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import IORedis from 'ioredis';
import type { Express } from 'express';
import type { Worker as BullMQWorker } from 'bullmq';
import request from 'supertest';
import type { Response } from 'supertest';

import { resetSettings } from '../../src/config';
import { registerRunner, resetRunners } from '../../src/runners/registry';
import type { AgentRunner, RunOptions, RunResult } from '../../src/runners/types';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';
import { agentConfigSchema } from '../../src/services/agent-loader.service';
import { resetQueues } from '../../src/services/queue.service';
import { closeTaskQueues } from '../../src/services/task.service';

export interface CapturedDelivery {
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly agentId: string;
  readonly sessionKey: string;
  readonly traceId: string | undefined;
  readonly receivedAt: string;
}

/**
 * Module-scoped store. Each test filters by a per-test marker embedded in
 * the dispatched payload — same pattern the Builder harness uses so tests
 * sharing the global runner registry don't cross-contaminate.
 */
const allDeliveries: CapturedDelivery[] = [];

/**
 * Captures every `runner.run()` call against the test stack. Registered
 * under multiple runner names so the same instance answers webhook
 * dispatch (`openclaw`) and internal-task dispatch (`claude-cli`) without
 * the test having to wire two runners.
 */
export class CapturingRunner implements AgentRunner {
  constructor(public readonly name: string) {}

  async run(options: RunOptions): Promise<RunResult> {
    allDeliveries.push({
      prompt: options.prompt,
      systemPrompt: options.systemPrompt ?? '',
      agentId: options.agentId,
      sessionKey: options.sessionKey,
      traceId: options.traceId,
      receivedAt: new Date().toISOString(),
    });
    return {
      status: 'ok',
      runId: `e2e-mock-run-${Date.now()}`,
      renderedPrompt: options.prompt,
    };
  }
}

/**
 * Re-register capturing runners under the names every dispatch path
 * resolves. The global `tests/setup.ts` runs `resetRunners()` in
 * `beforeEach`, so every test has to re-register before firing.
 */
export function installCapturingRunners(): void {
  resetRunners();
  registerRunner(new CapturingRunner('openclaw'));
  registerRunner(new CapturingRunner('claude-cli'));
}

export function getDeliveriesMatching(marker: string): CapturedDelivery[] {
  return allDeliveries.filter(
    (delivery) => delivery.prompt.includes(marker) || delivery.systemPrompt.includes(marker),
  );
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let testCounter = 0;
export function nextE2EMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${++testCounter}`;
}

/**
 * Poll the delivery store until `count` matches land for `marker`. Steps
 * at 50ms; default ceiling is 15s to absorb CI cold start.
 */
export async function waitForDeliveries(
  marker: string,
  count: number,
  timeoutMs = 15_000,
): Promise<CapturedDelivery[]> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const matched = getDeliveriesMatching(marker);
    if (matched.length >= count) return matched;
    await sleep(50);
  }
  const finalMatched = getDeliveriesMatching(marker);
  if (finalMatched.length >= count) return finalMatched;
  throw new Error(
    `Timed out waiting for ${count} runner deliveries matching "${marker}" ` +
      `(got ${finalMatched.length})`,
  );
}

/**
 * Drop every `clawndom:dedup:*` key from Redis. The webhook ingest
 * pipeline keys dedup on `provider:contextId:status`, so two successive
 * tests firing through the same provider and synthesizing identical
 * context (e.g. two gmail-pubsub tests using the same `emailAddress`)
 * would otherwise silently land inside the 60s dedup window. Pair this
 * with `beforeEach` in every dispatch-chain test.
 */
export async function clearDedupKeys(): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  try {
    const keys = await connection.keys('clawndom:dedup:*');
    if (keys.length > 0) {
      await connection.del(...keys);
    }
  } finally {
    await connection.quit();
  }
}

export interface E2EAgentTemplate {
  /** Name of the routing provider block (e.g. `internal`, `gmail-pubsub`). */
  readonly providerBlock: string;
  /** Rule name — also the `taskType` for internal-task dispatch. */
  readonly ruleName: string;
  /** Template body as nunjucks source (e.g. `"hello {{ from }}"`). */
  readonly templateSource: string;
}

/**
 * Materialize an agent workspace on disk with one internal routing rule
 * backed by a single nunjucks template. Returns a `ResolvedAgent` that can
 * be passed directly to `createApp` and to the task-worker. Caller cleans
 * up the temp dir via `cleanupAgent`.
 */
export async function buildInternalRuleAgent(options: {
  readonly agentName: string;
  readonly templates: readonly E2EAgentTemplate[];
}): Promise<{ agent: ResolvedAgent; cleanup: () => Promise<void> }> {
  const agentDir = await mkdtemp(join(tmpdir(), `clawndom-e2e-${options.agentName}-`));
  const templatesDir = join(agentDir, 'templates');
  await mkdir(templatesDir, { recursive: true });

  const routing: Record<string, { rules: Array<Record<string, unknown>> }> = {};
  for (const template of options.templates) {
    const templatePath = join('templates', `${template.ruleName}.njk`);
    await writeFile(join(agentDir, templatePath), template.templateSource, 'utf-8');
    const rule: Record<string, unknown> = {
      name: template.ruleName,
      messageTemplate: templatePath,
      // Bare prompt — IDENTITY/SOUL injection requires identity/IDENTITY.md
      // on disk, and the smoke tests assert what the agent SEES, not what
      // the boilerplate header injects. Opt out for predictability.
      identity: { identity: false, soul: false },
    };
    if (template.providerBlock === 'internal') {
      // Internal-task dispatch puts `taskType` at the payload root in
      // task-worker.service#processInternalTask. The condition picks the
      // matching rule by that field — same shape the production Winston
      // workspace uses for its `routing.internal` rules.
      rule['condition'] = {
        all_of: [{ equals: { field: 'taskType', value: template.ruleName } }],
      };
    } else {
      rule['condition'] = { all_of: [] };
    }
    routing[template.providerBlock] ??= { rules: [] };
    routing[template.providerBlock].rules.push(rule);
  }

  const config = agentConfigSchema.parse({ routing });
  const agent: ResolvedAgent = { name: options.agentName, dir: agentDir, config };

  return {
    agent,
    cleanup: async (): Promise<void> => {
      await rm(agentDir, { recursive: true, force: true });
    },
  };
}

export interface E2EWorkerSet {
  readonly workers: readonly BullMQWorker[];
  readonly queueNames: readonly string[];
  readonly taskQueueNames: readonly string[];
}

/**
 * Boot the full app stack for a smoke test:
 *   - Resets settings/queues/runners.
 *   - Re-registers capturing runners.
 *   - Loads system agents (Builder), splices in the caller's fixture agents.
 *   - Spins one BullMQ worker per configured provider AND one task worker
 *     per agent that declares `routing.internal` or `routing.schedule`.
 *
 * Returns the live Express app + worker set; the test passes the latter
 * to `stopE2EApp` in `afterAll`.
 */
export async function startE2EApp(options: {
  readonly providersConfig: readonly unknown[];
  readonly agentToken: string;
  readonly queuePrefix: string;
  readonly fixtureAgents: readonly ResolvedAgent[];
  readonly auditLogPath: string;
}): Promise<{ app: Express; workerSet: E2EWorkerSet; agents: readonly ResolvedAgent[] }> {
  process.env.BULLMQ_QUEUE_PREFIX = options.queuePrefix;
  process.env.PROVIDERS_CONFIG = JSON.stringify(options.providersConfig);
  process.env.CLAWNDOM_AGENT_TOKEN = options.agentToken;
  process.env.CLAWNDOM_AUDIT_LOG = options.auditLogPath;
  resetSettings();
  resetQueues();
  installCapturingRunners();

  // System agents (Builder) are deliberately NOT loaded here. The smoke
  // tests exercise the dispatch pipeline — webhook → ingest → worker →
  // runner — and shouldn't drag Builder's MCP tool surface in as a side
  // effect. Tests that DO want Builder in the agent list can pass her
  // explicitly via `fixtureAgents` (or build a dedicated harness layer).
  const agents = [...options.fixtureAgents];

  const { createApp } = await import('../../src/app');
  const app = createApp(agents);

  const { createWorker } = await import('../../src/services/worker.service');
  const { buildQueueName } = await import('../../src/services/queue.service');
  const { getSettings, isWebhookProvider } = await import('../../src/config');
  const webhookProviders = getSettings().providers.filter(isWebhookProvider);
  const webhookWorkers = webhookProviders.map((provider) => createWorker({ provider, agents }));
  const queueNames = webhookProviders.map((provider) => buildQueueName(provider.name));

  const { createTaskWorker } = await import('../../src/services/task-worker.service');
  const { buildTaskQueueName } = await import('../../src/services/task.service');
  const taskWorkers: BullMQWorker[] = [];
  const taskQueueNames: string[] = [];
  for (const agent of agents) {
    const worker = createTaskWorker(agent);
    if (worker !== null) {
      taskWorkers.push(worker);
      taskQueueNames.push(buildTaskQueueName(agent.name));
    }
  }

  // 500ms is the same settle window the existing Builder integration uses;
  // BullMQ workers need a beat to register as ready against Redis before
  // a freshly-enqueued job lands on the right worker. Shorter than this
  // and the first POST of the suite occasionally races the worker pickup.
  await sleep(500);

  return {
    app,
    workerSet: {
      workers: [...webhookWorkers, ...taskWorkers],
      queueNames,
      taskQueueNames,
    },
    agents,
  };
}

/**
 * Close every worker and obliterate the BullMQ queues this test owned.
 * Also clears env-var state so the next test's `startE2EApp` rehydrates
 * from clean. Always run in `afterAll`.
 */
export async function stopE2EApp(set: E2EWorkerSet): Promise<void> {
  for (const worker of set.workers) {
    await worker.close();
  }
  await closeTaskQueues();

  const { Queue } = await import('bullmq');
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  for (const queueName of [...set.queueNames, ...set.taskQueueNames]) {
    const queue = new Queue(queueName, { connection });
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await connection.quit();

  delete process.env.BULLMQ_QUEUE_PREFIX;
  delete process.env.PROVIDERS_CONFIG;
  delete process.env.CLAWNDOM_AGENT_TOKEN;
  delete process.env.CLAWNDOM_AUDIT_LOG;
  resetSettings();
  resetQueues();
  resetRunners();
}

/**
 * Fire a synthetic webhook through the in-process Express app. Returns
 * the supertest Response so the test can assert on status + body. JSON
 * payloads only — every smoke test uses JSON content type.
 */
export async function fireWebhook(
  app: Express,
  options: {
    readonly route: string;
    readonly payload: unknown;
    readonly headers?: Record<string, string>;
  },
): Promise<Response> {
  let pending = request(app).post(options.route).set('Content-Type', 'application/json');
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    pending = pending.set(name, value);
  }
  return pending.send(options.payload as object);
}

/**
 * Dispatch an internal task via `/api/tasks` (the same surface
 * `dispatch_task` POSTs against from the Python tool side). Bearer auth
 * is attached automatically from `process.env.CLAWNDOM_AGENT_TOKEN`.
 */
export async function dispatchInternalTask(
  app: Express,
  options: {
    readonly agent: string;
    readonly taskType: string;
    readonly context: Record<string, unknown>;
  },
): Promise<Response> {
  const token = process.env.CLAWNDOM_AGENT_TOKEN ?? '';
  return request(app)
    .post('/api/tasks')
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${token}`)
    .send({
      agent: options.agent,
      taskType: options.taskType,
      context: options.context,
    });
}

/**
 * Read every audit-log record at `CLAWNDOM_AUDIT_LOG` and parse them as
 * NDJSON. Returns an empty array when the file doesn't exist yet (no
 * tool calls fired in this test). Filters to records whose `tool_name`
 * matches `toolNameFilter` when provided.
 */
export async function readAuditRecords(options: {
  readonly auditLogPath: string;
  readonly toolNameFilter?: string;
}): Promise<readonly Record<string, unknown>[]> {
  let contents: string;
  try {
    contents = await readFile(options.auditLogPath, 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const records: Record<string, unknown>[] = [];
  for (const line of contents.split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (options.toolNameFilter === undefined || parsed['tool_name'] === options.toolNameFilter) {
      records.push(parsed);
    }
  }
  return records;
}

export interface E2ETestContext {
  readonly tmpRoot: string;
  readonly auditLogPath: string;
  readonly queuePrefix: string;
  readonly agentToken: string;
}

/**
 * Per-suite test context. Allocates a temp dir for fixtures (templates,
 * audit log), a unique BullMQ queue prefix, and a bearer token. Cleanup
 * removes the temp dir; queue prefix isolation guarantees suites can run
 * in parallel without colliding on `clawndom-jobs-jira` etc.
 */
export async function createE2ETestContext(suiteName: string): Promise<{
  readonly context: E2ETestContext;
  readonly cleanup: () => Promise<void>;
}> {
  const tmpRoot = await mkdtemp(join(tmpdir(), `clawndom-e2e-${suiteName}-`));
  const auditLogPath = join(tmpRoot, 'audit.log');
  const queuePrefix = `test-e2e-${suiteName}-${Date.now()}`;
  const agentToken = `e2e-${suiteName}-token-${Date.now()}`;
  return {
    context: { tmpRoot, auditLogPath, queuePrefix, agentToken },
    cleanup: async (): Promise<void> => {
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}
