import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { setScheduledTasksRegistryForTests } from '../../src/controllers/scheduled-tasks.controller';
import { createScheduledTasksRoutes } from '../../src/routes/scheduled-tasks.routes';
import { requireAgentBearer } from '../../src/middleware/bearer-auth.middleware';
import type {
  ScheduledTasksService,
  CreateScheduledTaskInput,
  ScheduledTaskListFilters,
  ScheduledTaskListPage,
} from '../../src/services/scheduled-tasks.service';
import type { ScheduledTask } from '../../src/types/scheduled-task';

const VALID_TOKEN = 'test-bearer-token';

interface RegistryRecorder {
  upserts: CreateScheduledTaskInput[];
  deletes: string[];
  lists: { filters: ScheduledTaskListFilters; cursor?: string; limit?: number }[];
}

function makeRegistryStub(records: Map<string, ScheduledTask>): {
  registry: ScheduledTasksService;
  recorder: RegistryRecorder;
} {
  const recorder: RegistryRecorder = { upserts: [], deletes: [], lists: [] };
  const registry = {
    async upsert(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
      recorder.upserts.push(input);
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

function mountApp(): Express {
  const app = express();
  app.use('/api/scheduled-tasks', express.json(), requireAgentBearer, createScheduledTasksRoutes());
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
  });
});
