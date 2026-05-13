import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createContextSchemasHandler } from '../../src/controllers/context-schemas.controller';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';

function mountApp(agents: readonly ResolvedAgent[]): Express {
  const app = express();
  app.get('/api/agents/:agent/context-schemas', createContextSchemasHandler(agents));
  return app;
}

function fakeAgent(name: string, providers: readonly string[]): ResolvedAgent {
  const routing: Record<string, { rules: unknown[] }> = {};
  for (const p of providers) routing[p] = { rules: [] };
  return {
    name,
    dir: `/tmp/${name}`,
    config: {
      routing,
      modelRules: {},
    } as unknown as ResolvedAgent['config'],
  };
}

describe('GET /api/agents/:agent/context-schemas', () => {
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

  it('returns a schema map keyed by the agent provider names', async () => {
    await start([fakeAgent('winston', ['gmail-pubsub', 'slack-winston', 'internal'])]);
    const response = await fetch(`${baseUrl}/api/agents/winston/context-schemas`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agent: string;
      providers: Record<string, { type?: string }>;
    };
    expect(body.agent).toBe('winston');
    expect(Object.keys(body.providers).sort((a, b) => a.localeCompare(b))).toEqual([
      'gmail-pubsub',
      'internal',
      'slack-winston',
    ]);
  });

  it('omits providers without a registered payload schema', async () => {
    await start([fakeAgent('experimental', ['zapier', 'internal'])]);
    const response = await fetch(`${baseUrl}/api/agents/experimental/context-schemas`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: Record<string, unknown> };
    expect(Object.keys(body.providers)).toEqual(['internal']);
  });

  it('returns 404 when the agent is unknown', async () => {
    await start([fakeAgent('winston', ['internal'])]);
    const response = await fetch(`${baseUrl}/api/agents/phantom/context-schemas`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('phantom');
  });
});
