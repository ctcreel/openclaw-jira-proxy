import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createOperationsDocHandler } from '../../src/controllers/operations-doc.controller';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';

vi.mock('../../src/services/version.service', () => ({
  getAgentVersion: (): {
    hash: string;
    repos: ReadonlyArray<{ name: string; sha: string; dirty: boolean }>;
  } => ({
    hash: 'sha256:test',
    repos: [{ name: 'clawndom', sha: 'deadbeef', dirty: false }],
  }),
}));

vi.mock('../../src/config', async () => ({
  getSettings: (): { port: number; providers: readonly never[] } => ({
    port: 8794,
    providers: [],
  }),
}));

function fakeAgent(name: string): ResolvedAgent {
  return {
    name,
    dir: `/tmp/${name}`,
    config: {
      routing: {},
      modelRules: {},
    } as unknown as ResolvedAgent['config'],
  };
}

function mountApp(agents: readonly ResolvedAgent[]): Express {
  const app = express();
  app.get('/api/agents/:agent/operations.md', createOperationsDocHandler(agents));
  return app;
}

describe('GET /api/agents/:agent/operations.md', () => {
  let server: Server;
  let baseUrl: string;

  function start(agents: readonly ResolvedAgent[]): Promise<void> {
    return new Promise<void>((resolve) => {
      server = createServer(mountApp(agents));
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('responds with text/markdown content type', async () => {
    await start([fakeAgent('winston')]);
    const response = await fetch(`${baseUrl}/api/agents/winston/operations.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
  });

  it('returns markdown beginning with the per-agent title', async () => {
    await start([fakeAgent('winston')]);
    const response = await fetch(`${baseUrl}/api/agents/winston/operations.md`);
    const body = await response.text();
    expect(body.startsWith('# Operations: winston')).toBe(true);
  });

  it('returns 404 when the agent is unknown', async () => {
    await start([fakeAgent('winston')]);
    const response = await fetch(`${baseUrl}/api/agents/phantom/operations.md`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('phantom');
  });

  it('returns 400 when invoked with a missing agent param (defensive branch)', async () => {
    // Express won't route /api/agents//operations.md to a handler with
    // an empty :agent param, so we test the defensive branch by calling
    // the handler directly with a constructed request.
    await start([fakeAgent('winston')]);
    const handler = createOperationsDocHandler([fakeAgent('winston')]);
    const fakeRequest = { params: { agent: '' } } as unknown as Parameters<typeof handler>[0];
    let captured: { status: number; body: unknown } | undefined;
    const fakeResponse = {
      status(code: number) {
        captured = { status: code, body: undefined };
        return this;
      },
      json(payload: unknown) {
        if (captured !== undefined) captured.body = payload;
      },
      setHeader() {
        /* unused on this branch */
      },
      send() {
        /* unused on this branch */
      },
    } as unknown as Parameters<typeof handler>[1];
    handler(fakeRequest, fakeResponse);
    expect(captured?.status).toBe(400);
  });
});
