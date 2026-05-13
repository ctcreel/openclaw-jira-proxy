import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { listAgentTools, listToolCatalog } from '../../src/controllers/tool-catalog.controller';
import { getToolCatalog, resetToolCatalog } from '../../src/services/tool-catalog.service';
import type { ToolDescriptor } from '../../src/services/tools/descriptor';

function mountApp(): Express {
  const app = express();
  app.get('/api/tools/catalog', listToolCatalog);
  app.get('/api/agents/:agent/tools', listAgentTools);
  return app;
}

function descriptor(reference: string, name: string): ToolDescriptor {
  return {
    directory: `/agents/winston/agency-tools/${reference.replace(/\./g, '/')}`,
    reference,
    name,
    description: `${name} tool description`,
    args: {},
    secrets: [],
  };
}

describe('tool-catalog controller', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    resetToolCatalog();
    const app = mountApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    resetToolCatalog();
  });

  describe('GET /api/tools/catalog', () => {
    it('returns every registered tool', async () => {
      const catalog = getToolCatalog();
      catalog.register('winston', descriptor('agency_tools.google.gmail_send', 'gmail_send'));
      catalog.register('patch', descriptor('agency_tools.jira.add_comment', 'jira_add_comment'));

      const response = await fetch(`${baseUrl}/api/tools/catalog`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { tools: Array<{ reference: string }> };
      expect(body.tools.map((t) => t.reference).sort((a, b) => a.localeCompare(b))).toEqual([
        'agency_tools.google.gmail_send',
        'agency_tools.jira.add_comment',
      ]);
    });

    it('returns empty array when no tools registered', async () => {
      const response = await fetch(`${baseUrl}/api/tools/catalog`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tools: [] });
    });
  });

  describe('GET /api/agents/:agent/tools', () => {
    it('returns the agent-scoped subset', async () => {
      const catalog = getToolCatalog();
      catalog.register('winston', descriptor('agency_tools.google.gmail_send', 'gmail_send'));
      catalog.register('winston', descriptor('agency_tools.google.gmail_label', 'gmail_label'));
      catalog.register('patch', descriptor('agency_tools.jira.add_comment', 'jira_add_comment'));

      const response = await fetch(`${baseUrl}/api/agents/winston/tools`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        agent: string;
        tools: Array<{ reference: string }>;
      };
      expect(body.agent).toBe('winston');
      expect(body.tools.map((t) => t.reference).sort((a, b) => a.localeCompare(b))).toEqual([
        'agency_tools.google.gmail_label',
        'agency_tools.google.gmail_send',
      ]);
    });

    it('returns 404 when the agent is unknown', async () => {
      getToolCatalog().register(
        'winston',
        descriptor('agency_tools.google.gmail_send', 'gmail_send'),
      );

      const response = await fetch(`${baseUrl}/api/agents/phantom/tools`);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('phantom');
    });
  });
});
