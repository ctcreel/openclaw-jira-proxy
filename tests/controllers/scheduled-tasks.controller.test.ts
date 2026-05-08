import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setScheduledTasksRegistryForTests } from '../../src/controllers/scheduled-tasks.controller';
import { createScheduledTasksRoutes } from '../../src/routes/scheduled-tasks.routes';
import { requireAgentBearer } from '../../src/middleware/bearer-auth.middleware';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';
import {
  CapExceededError,
  type ScheduledTasksService,
  type CreateScheduledTaskInput,
  type ScheduledTaskListFilters,
  type ScheduledTaskListPage,
} from '../../src/services/scheduled-tasks.service';
import type { ScheduledTask } from '../../src/types/scheduled-task';

const VALID_TOKEN = 'test-bearer-token';

interface RegistryRecorder {
  upserts: CreateScheduledTaskInput[];
  deletes: string[];
  lists: { filters: ScheduledTaskListFilters; cursor?: string; limit?: number }[];
}

interface RegistryStubOptions {
  /**
   * Optional throw-on-upsert hook so tests can simulate
   * `CapExceededError` being raised by the registry without booting Redis.
   */
  upsertThrows?: Error;
}

function makeRegistryStub(
  records: Map<string, ScheduledTask>,
  options: RegistryStubOptions = {},
): {
  registry: ScheduledTasksService;
  recorder: RegistryRecorder;
} {
  const recorder: RegistryRecorder = { upserts: [], deletes: [], lists: [] };
  const registry = {
    async upsert(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
      recorder.upserts.push(input);
      if (options.upsertThrows) {
        throw options.upsertThrows;
      }
      const task: ScheduledTask = {
        id: input.id ?? `gen-${recorder.upserts.length}`,
        agentId: input.agentId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        when: input.when,
        runner: input.runner,
        runnerConfig: input.runnerConfig,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        createdBy: input.createdBy,
        ...(input.createdByTraceId !== undefined
          ? { createdByTraceId: input.createdByTraceId }
          : {}),
        ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
        ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
        runCount: 0,
        createdAt: 1_700_000_000_000,
      };
      records.set(task.id, task);
      return task;
    },
    async getById(id: string): Promise<ScheduledTask | undefined> {
      return records.get(id);
    },
    async list(
      filters: ScheduledTaskListFilters = {},
      options: { cursor?: string; limit?: number } = {},
    ): Promise<ScheduledTaskListPage> {
      recorder.lists.push({ filters, ...options });
      const all = [...records.values()];
      // Honor an opaque cursor in the same shape the real registry uses
      // (base64url JSON `{ o: <offset> }`) so the round-trip test is
      // exercising the controller's pass-through behaviour, not a custom
      // stub format.
      let offset = 0;
      if (options.cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf-8')) as {
            o?: number;
          };
          if (typeof parsed.o === 'number') offset = parsed.o;
        } catch {
          offset = 0;
        }
      }
      const limit = options.limit ?? all.length;
      const slice = all.slice(offset, offset + limit);
      const next = offset + slice.length;
      const nextCursor =
        next < all.length
          ? Buffer.from(JSON.stringify({ o: next }), 'utf-8').toString('base64url')
          : null;
      return { tasks: slice, nextCursor };
    },
    async delete(id: string): Promise<{ removed: boolean }> {
      recorder.deletes.push(id);
      const existed = records.has(id);
      records.delete(id);
      return { removed: existed };
    },
  } as unknown as ScheduledTasksService;
  return { registry, recorder };
}

/**
 * Stub agents array. The agent-prompt endpoint only needs `name` and
 * `dir` from each entry; `config` is cast as the controller never reads
 * it, but TypeScript doesn't know that.
 */
const STUB_AGENTS: readonly ResolvedAgent[] = [
  { name: 'patch', dir: '/agents/patch', config: {} as ResolvedAgent['config'] },
  { name: 'scarlett', dir: '/agents/scarlett', config: {} as ResolvedAgent['config'] },
];

function mountApp(agents: readonly ResolvedAgent[] = STUB_AGENTS): Express {
  const app = express();
  app.use(
    '/api/scheduled-tasks',
    express.json(),
    requireAgentBearer,
    createScheduledTasksRoutes(agents),
  );
  return app;
}

function bearerHeader(token = VALID_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('scheduled-tasks controller', () => {
  let server: Server;
  let baseUrl: string;
  let originalToken: string | undefined;
  let records: Map<string, ScheduledTask>;
  let recorder: RegistryRecorder;

  beforeEach(async () => {
    originalToken = process.env['CLAWNDOM_AGENT_TOKEN'];
    process.env['CLAWNDOM_AGENT_TOKEN'] = VALID_TOKEN;
    records = new Map();
    const stub = makeRegistryStub(records);
    recorder = stub.recorder;
    setScheduledTasksRegistryForTests(stub.registry);
    server = createServer(mountApp());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    setScheduledTasksRegistryForTests(null);
    if (originalToken === undefined) {
      delete process.env['CLAWNDOM_AGENT_TOKEN'];
    } else {
      process.env['CLAWNDOM_AGENT_TOKEN'] = originalToken;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('auth', () => {
    it('rejects unauthenticated GET (401)', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`);
      expect(response.status).toBe(401);
    });

    it('rejects unauthenticated POST without parsing body (401)', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(401);
      // Confirms the middleware short-circuited before the registry was hit.
      expect(recorder.upserts).toHaveLength(0);
    });

    it('rejects a wrong token (401)', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/scheduled-tasks', () => {
    const validBody = {
      agentId: 'patch',
      name: 'one-shot-thing',
      when: { fireAt: 1_700_000_500_000 },
      runner: 'claude-cli',
      runnerConfig: { type: 'claude-cli', workDirectory: '/agents/patch' },
    };

    it('creates an agent-owned task and returns 201 with the persisted record', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify(validBody),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as ScheduledTask;
      expect(body).toMatchObject({
        agentId: 'patch',
        name: 'one-shot-thing',
        when: { fireAt: 1_700_000_500_000 },
        createdBy: 'agent',
      });
      expect(recorder.upserts[0]).toMatchObject({
        agentId: 'patch',
        createdBy: 'agent',
        reason: 'api-create',
      });
    });

    it('rejects shell-runner config (400)', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify({
          ...validBody,
          runner: 'shell',
          runnerConfig: { type: 'shell', command: 'rm -rf /', timeoutMs: 1000 },
        }),
      });
      expect(response.status).toBe(400);
      expect(recorder.upserts).toHaveLength(0);
    });

    it('rejects malformed payloads (400)', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify({ agentId: 'patch' }),
      });
      expect(response.status).toBe(400);
    });

    it('passes ttl/maxRuns/createdByTraceId through to the registry', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify({
          ...validBody,
          ttl: 1_700_999_999_999,
          maxRuns: 5,
          createdByTraceId: 'agent-trace-123',
        }),
      });
      expect(response.status).toBe(201);
      expect(recorder.upserts[0]).toMatchObject({
        ttl: 1_700_999_999_999,
        maxRuns: 5,
        createdByTraceId: 'agent-trace-123',
      });
    });
  });

  describe('GET /api/scheduled-tasks', () => {
    beforeEach(() => {
      records.set('a', {
        id: 'a',
        agentId: 'patch',
        when: { fireAt: 1 },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/x' },
        createdBy: 'config',
        runCount: 0,
        createdAt: 0,
      });
      records.set('b', {
        id: 'b',
        agentId: 'scarlett',
        when: { fireAt: 2 },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/x' },
        createdBy: 'agent',
        runCount: 0,
        createdAt: 0,
      });
      records.set('c', {
        id: 'c',
        agentId: 'patch',
        when: { fireAt: 3 },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/x' },
        createdBy: 'agent',
        runCount: 0,
        createdAt: 0,
      });
    });

    it('returns 200 with all tasks when no filters', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
        headers: bearerHeader(),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { tasks: ScheduledTask[]; nextCursor: string | null };
      expect(body.tasks).toHaveLength(3);
    });

    it('passes filters through to the registry', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks?createdBy=agent&agentId=patch`, {
        headers: bearerHeader(),
      });
      expect(response.status).toBe(200);
      expect(recorder.lists.at(-1)?.filters).toEqual({
        createdBy: 'agent',
        agentId: 'patch',
      });
    });

    it('rejects an invalid createdBy filter (400)', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks?createdBy=garbage`, {
        headers: bearerHeader(),
      });
      expect(response.status).toBe(400);
    });

    it('round-trips the cursor across pages', async () => {
      const first = await (
        await fetch(`${baseUrl}/api/scheduled-tasks?limit=2`, { headers: bearerHeader() })
      ).json();
      expect((first as { tasks: ScheduledTask[] }).tasks).toHaveLength(2);
      const cursor = (first as { nextCursor: string }).nextCursor;
      expect(cursor).toBeTruthy();
      const second = await (
        await fetch(`${baseUrl}/api/scheduled-tasks?limit=2&cursor=${encodeURIComponent(cursor)}`, {
          headers: bearerHeader(),
        })
      ).json();
      expect((second as { tasks: ScheduledTask[] }).tasks).toHaveLength(1);
      expect((second as { nextCursor: string | null }).nextCursor).toBeNull();
    });
  });

  describe('GET /api/scheduled-tasks/:id', () => {
    it('returns the record on hit (200)', async () => {
      records.set('hit', {
        id: 'hit',
        agentId: 'patch',
        when: { fireAt: 1 },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/x' },
        createdBy: 'agent',
        runCount: 0,
        createdAt: 0,
      });
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/hit`, {
        headers: bearerHeader(),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as ScheduledTask;
      expect(body.id).toBe('hit');
    });

    it('returns 404 on miss', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/missing`, {
        headers: bearerHeader(),
      });
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/scheduled-tasks/:id', () => {
    it('returns 204 on successful delete', async () => {
      records.set('del', {
        id: 'del',
        agentId: 'patch',
        when: { fireAt: 1 },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/x' },
        createdBy: 'agent',
        runCount: 0,
        createdAt: 0,
      });
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/del`, {
        method: 'DELETE',
        headers: bearerHeader(),
      });
      expect(response.status).toBe(204);
      expect(recorder.deletes).toEqual(['del']);
    });

    it('returns 404 when the id is unknown', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/missing`, {
        method: 'DELETE',
        headers: bearerHeader(),
      });
      expect(response.status).toBe(404);
    });

    /**
     * Ownership gate (SPE-2049): when the request carries `?agentId=<id>`,
     * the controller must refuse to delete a record owned by a different
     * agent — and crucially, must return 403 BEFORE calling
     * `registry.delete`, so no `scheduled-task.cancelled` event leaks
     * into the SSE stream that other agents consume.
     */
    it('returns 403 when ?agentId does not match the record owner', async () => {
      records.set('owned-by-scarlett', {
        id: 'owned-by-scarlett',
        agentId: 'scarlett',
        when: { fireAt: 1 },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/x' },
        createdBy: 'agent',
        runCount: 0,
        createdAt: 0,
      });
      const response = await fetch(
        `${baseUrl}/api/scheduled-tasks/owned-by-scarlett?agentId=patch`,
        { method: 'DELETE', headers: bearerHeader() },
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('scarlett');
      // Critical invariant: registry.delete must NOT have been called —
      // a 403 path that emitted a `scheduled-task.cancelled` event would
      // leak the existence + identity of another agent's schedule.
      expect(recorder.deletes).toEqual([]);
      // Record stays in storage.
      expect(records.has('owned-by-scarlett')).toBe(true);
    });

    it('allows owner to delete its own record (204)', async () => {
      records.set('owned-by-patch', {
        id: 'owned-by-patch',
        agentId: 'patch',
        when: { fireAt: 1 },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/x' },
        createdBy: 'agent',
        runCount: 0,
        createdAt: 0,
      });
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/owned-by-patch?agentId=patch`, {
        method: 'DELETE',
        headers: bearerHeader(),
      });
      expect(response.status).toBe(204);
      expect(recorder.deletes).toEqual(['owned-by-patch']);
    });

    it('returns 404 when ?agentId is supplied but the record does not exist', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/missing?agentId=patch`, {
        method: 'DELETE',
        headers: bearerHeader(),
      });
      expect(response.status).toBe(404);
      // Same invariant: no event leaks for a record that doesn't exist.
      expect(recorder.deletes).toEqual([]);
    });
  });

  describe('POST /api/scheduled-tasks/agent-prompt', () => {
    const validPromptBody = {
      agentId: 'patch',
      prompt: 'Investigate SPE-1234 on a 30-minute cadence and summarize.',
      when: { cron: '*/30 * * * *' },
    };

    it('creates a direct-prompt task, synthesizing claude-cli runner config from the agent registry (201)', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/agent-prompt`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify(validPromptBody),
      });
      expect(response.status).toBe(201);
      expect(recorder.upserts).toHaveLength(1);
      const upsert = recorder.upserts[0]!;
      expect(upsert).toMatchObject({
        agentId: 'patch',
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/agents/patch' },
        createdBy: 'agent',
        reason: 'api-create',
      });
      // Prompt is stored under payload.directPrompt for the worker's
      // verbatim-replay path; useMemory is omitted when not supplied.
      expect(upsert.payload).toEqual({ directPrompt: validPromptBody.prompt });
    });

    it('returns 404 when the agentId is not in the agent registry', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/agent-prompt`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify({ ...validPromptBody, agentId: 'ghost' }),
      });
      expect(response.status).toBe(404);
      expect(recorder.upserts).toHaveLength(0);
    });

    it('threads useMemory + extra context into payload', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/agent-prompt`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify({
          ...validPromptBody,
          useMemory: { namespace: 'jira', topK: 8 },
          context: { ticketKey: 'SPE-1234' },
          traceId: 'agent-trace-7',
        }),
      });
      expect(response.status).toBe(201);
      const upsert = recorder.upserts[0]!;
      expect(upsert.payload).toEqual({
        directPrompt: validPromptBody.prompt,
        useMemory: { namespace: 'jira', topK: 8 },
        ticketKey: 'SPE-1234',
      });
      expect(upsert.createdByTraceId).toBe('agent-trace-7');
    });

    it('rejects malformed payloads (400)', async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks/agent-prompt`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify({ agentId: 'patch' }),
      });
      expect(response.status).toBe(400);
      expect(recorder.upserts).toHaveLength(0);
    });
  });

  /**
   * Cap enforcement happens inside ScheduledTasksService.upsert; the
   * controller's job is just to surface the right HTTP shape. We stub
   * the registry to throw `CapExceededError` and verify the mapping
   * and pass-through fields without booting Redis.
   */
  describe('CapExceededError mapping', () => {
    it('per-trace overflow → 429 with cap/limit/observed fields', async () => {
      // Re-mount with a registry that throws on every upsert.
      const localRecords = new Map<string, ScheduledTask>();
      const stub = makeRegistryStub(localRecords, {
        upsertThrows: new CapExceededError('per-trace', 10, 11),
      });
      setScheduledTasksRegistryForTests(stub.registry);

      const response = await fetch(`${baseUrl}/api/scheduled-tasks/agent-prompt`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify({
          agentId: 'patch',
          prompt: 'p',
          when: { fireAt: 1_700_000_500_000 },
        }),
      });
      expect(response.status).toBe(429);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ cap: 'per-trace', limit: 10, observed: 11 });
    });

    it('future-window overflow → 422 with cap/limit/observed fields', async () => {
      const localRecords = new Map<string, ScheduledTask>();
      const stub = makeRegistryStub(localRecords, {
        upsertThrows: new CapExceededError('future-window', 1_000, 5_000),
      });
      setScheduledTasksRegistryForTests(stub.registry);

      const response = await fetch(`${baseUrl}/api/scheduled-tasks/agent-prompt`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify({
          agentId: 'patch',
          prompt: 'p',
          when: { fireAt: 1_700_000_500_000 },
        }),
      });
      expect(response.status).toBe(422);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ cap: 'future-window', limit: 1_000, observed: 5_000 });
    });

    it('per-trace overflow on operator endpoint also surfaces 429', async () => {
      const localRecords = new Map<string, ScheduledTask>();
      const stub = makeRegistryStub(localRecords, {
        upsertThrows: new CapExceededError('per-trace', 10, 11),
      });
      setScheduledTasksRegistryForTests(stub.registry);

      const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
        method: 'POST',
        headers: bearerHeader(),
        body: JSON.stringify({
          agentId: 'patch',
          when: { fireAt: 1_700_000_500_000 },
          runner: 'claude-cli',
          runnerConfig: { type: 'claude-cli', workDirectory: '/agents/patch' },
        }),
      });
      expect(response.status).toBe(429);
    });
  });
});
