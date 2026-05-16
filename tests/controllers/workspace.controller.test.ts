import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createWorkspaceAuditHandler,
  createWorkspaceHandler,
} from '../../src/controllers/workspace.controller';
import type { AgentConfig, ResolvedAgent } from '../../src/services/agent-loader.service';
import { resetToolCatalog } from '../../src/services/tool-catalog.service';

function mountApp(agents: readonly ResolvedAgent[]): Express {
  const app = express();
  app.get('/api/workspace/:agent', createWorkspaceHandler(agents));
  app.post('/api/workspace/:agent/audit', createWorkspaceAuditHandler(agents));
  return app;
}

const EMPTY_CONFIG: AgentConfig = { routing: {}, modelRules: {} };

describe('workspace controller', () => {
  let server: Server;
  let baseUrl: string;
  let workspaceDir: string;

  beforeEach(async () => {
    resetToolCatalog();
    workspaceDir = await mkdtemp(join(tmpdir(), 'workspace-test-'));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(workspaceDir, { recursive: true, force: true });
  });

  async function startWithAgent(agent: ResolvedAgent): Promise<void> {
    const app = mountApp([agent]);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  describe('GET /api/workspace/:agent', () => {
    it('returns 400 with no agent path param', async () => {
      await startWithAgent({ name: 'winston', dir: workspaceDir, config: EMPTY_CONFIG });
      // Express will 404 on a path that doesn't match the route, so test the
      // explicit 400 by mounting against an empty-string param-style route.
      // Direct invocation suffices.
      const handler = createWorkspaceHandler([
        { name: 'winston', dir: workspaceDir, config: EMPTY_CONFIG },
      ]);
      const responseMock = {
        statusCalls: [] as number[],
        jsonBody: undefined as unknown,
        status(code: number): typeof responseMock {
          this.statusCalls.push(code);
          return this;
        },
        json(body: unknown): typeof responseMock {
          this.jsonBody = body;
          return this;
        },
      };
      await handler(
        { params: { agent: '' } } as unknown as Parameters<typeof handler>[0],
        responseMock as unknown as Parameters<typeof handler>[1],
      );
      expect(responseMock.statusCalls).toContain(400);
    });

    it('returns 404 when the agent is not loaded', async () => {
      await startWithAgent({ name: 'winston', dir: workspaceDir, config: EMPTY_CONFIG });
      const response = await fetch(`${baseUrl}/api/workspace/nope`);
      expect(response.status).toBe(404);
    });

    it('returns the parsed config + empty templates + empty tools when the dir has nothing', async () => {
      await startWithAgent({ name: 'winston', dir: workspaceDir, config: EMPTY_CONFIG });
      const response = await fetch(`${baseUrl}/api/workspace/winston`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['agent']).toBe('winston');
      expect(body['dir']).toBe(workspaceDir);
      expect(body['config']).toEqual(EMPTY_CONFIG);
      expect(body['templates']).toEqual([]);
      expect(body['tools']).toEqual([]);
      expect(body).toHaveProperty('contextSchemas');
    });

    it('lists template files with byte sizes, filtering to .md and .njk only', async () => {
      const templatesDir = join(workspaceDir, 'templates');
      await mkdir(templatesDir, { recursive: true });
      await writeFile(join(templatesDir, 'a-rule.md'), 'hello world\n');
      await writeFile(join(templatesDir, 'dispatch.njk'), '{{ x }}\n');
      await writeFile(join(templatesDir, 'README.txt'), 'should be filtered\n');
      await startWithAgent({ name: 'winston', dir: workspaceDir, config: EMPTY_CONFIG });

      const response = await fetch(`${baseUrl}/api/workspace/winston`);
      const body = (await response.json()) as {
        templates: Array<{ path: string; sizeBytes: number }>;
      };
      const paths = body.templates.map((t) => t.path);
      expect(paths).toEqual(['templates/a-rule.md', 'templates/dispatch.njk']);
      const sizesAll = body.templates.every(
        (t) => typeof t.sizeBytes === 'number' && t.sizeBytes > 0,
      );
      expect(sizesAll).toBe(true);
    });

    it('returns empty templates when the templates/ dir does not exist', async () => {
      await startWithAgent({ name: 'winston', dir: workspaceDir, config: EMPTY_CONFIG });
      const response = await fetch(`${baseUrl}/api/workspace/winston`);
      const body = (await response.json()) as { templates: unknown };
      expect(body.templates).toEqual([]);
    });
  });

  describe('POST /api/workspace/:agent/audit', () => {
    it('returns the audit report shape (findings array) for a workspace with no clawndom.yaml — surfaces missing-clawndom-yaml error', async () => {
      await startWithAgent({ name: 'winston', dir: workspaceDir, config: EMPTY_CONFIG });
      const response = await fetch(`${baseUrl}/api/workspace/winston/audit`, { method: 'POST' });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        findings: Array<{ severity: string; rule: string }>;
      };
      expect(Array.isArray(body.findings)).toBe(true);
      const missingYaml = body.findings.find((f) => f.rule === 'missing-clawndom-yaml');
      expect(missingYaml?.severity).toBe('error');
    });

    it('returns 404 when the agent is not loaded', async () => {
      await startWithAgent({ name: 'winston', dir: workspaceDir, config: EMPTY_CONFIG });
      const response = await fetch(`${baseUrl}/api/workspace/nope/audit`, { method: 'POST' });
      expect(response.status).toBe(404);
    });
  });
});
