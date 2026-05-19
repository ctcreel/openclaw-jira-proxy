/**
 * API-driven integration test for the entity-store substrate.
 *
 * Boots a real Express server with the entities routes mounted +
 * bearer auth + the agent registry seeded with Winston's full
 * workspace (six kinds, the relations.json). Then hits the HTTP
 * endpoints with the bearer token, the way agency-tools clients
 * do in production.
 *
 * Proves the wire-level contract works end-to-end: create entities
 * over HTTP, relate them, find them by relation, fetch with expansion,
 * read audit, unrelate, list. No service-layer shortcuts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEntitiesRoutes } from '../../src/routes/entities.routes';
import {
  type AgentEntityContext,
  getEntityRegistry,
  resetEntityRegistry,
} from '../../src/services/entities/entity-registry';
import type { EntityKindSchema } from '../../src/services/entities/entity-schema.service';

const BEARER_TOKEN = 'test-bearer-token-for-api-integration';

let tempDir: string;
let workspacePath: string;
let context: AgentEntityContext;
let server: Server;
let baseUrl: string;
let originalToken: string | undefined;

const WINSTON_KINDS: Record<string, EntityKindSchema> = {
  team_member: {
    type: 'object',
    required: ['email', 'status'],
    properties: {
      email: { type: 'string', format: 'email' },
      slack_user_id: { type: 'string' },
      role: { type: 'string' },
      status: { type: 'string', enum: ['active', 'departed'] },
    },
    'x-natural-keys': ['email'],
  },
  client: {
    type: 'object',
    required: ['legal_name', 'status'],
    properties: {
      legal_name: { type: 'string' },
      nickname: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' } },
      date_of_birth: { type: 'string', format: 'date' },
      status: { type: 'string', enum: ['active', 'former'] },
    },
    'x-natural-keys': ['legal_name', 'date_of_birth'],
  },
  contact: {
    type: 'object',
    required: ['status'],
    properties: {
      email: { type: 'string', format: 'email' },
      phone: { type: 'string' },
      status: { type: 'string', enum: ['active', 'inactive'] },
    },
    'x-natural-keys': ['email'],
  },
  memory: {
    type: 'object',
    required: ['text', 'status'],
    properties: {
      text: { type: 'string' },
      written_at: { type: 'string', format: 'date' },
      status: { type: 'string', enum: ['active', 'forgotten'] },
    },
  },
  interaction: {
    type: 'object',
    required: ['inbound_text', 'outbound_summary', 'surface', 'route'],
    properties: {
      inbound_text: { type: 'string' },
      outbound_summary: { type: 'string' },
      surface: { type: 'string' },
      route: { type: 'string' },
      trace_id: { type: 'string' },
      actor_email: { type: 'string' },
    },
  },
};

const WINSTON_RELATIONS = {
  has_therapist: { from: 'client', to: 'team_member' },
  has_contact: { from: 'client', to: 'contact' },
  about: { from: 'interaction', to: 'client' },
  from: { from: 'interaction', to: 'team_member' },
  memory_about: { from: 'memory', to: 'client' },
};

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

async function apiCall(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  token: string | null = BEARER_TOKEN,
): Promise<ApiResponse> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${path}`);
    const headers: Record<string, string> = {};
    if (token !== null) headers['authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const requestObject = request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const parsed = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
          resolve({ status: response.statusCode ?? 0, body: parsed });
        });
        response.on('error', reject);
      },
    );
    requestObject.on('error', reject);
    if (body !== undefined) requestObject.write(JSON.stringify(body));
    requestObject.end();
  });
}

beforeEach(async () => {
  originalToken = process.env['CLAWNDOM_AGENT_TOKEN'];
  process.env['CLAWNDOM_AGENT_TOKEN'] = BEARER_TOKEN;

  tempDir = mkdtempSync(join(tmpdir(), 'clawndom-api-integ-'));
  workspacePath = join(tempDir, 'workspace');
  const schemasDir = join(workspacePath, 'schemas');
  mkdirSync(schemasDir, { recursive: true });
  for (const [kind, schema] of Object.entries(WINSTON_KINDS)) {
    writeFileSync(join(schemasDir, `${kind}.schema.json`), JSON.stringify(schema));
  }
  writeFileSync(join(workspacePath, 'relations.json'), JSON.stringify(WINSTON_RELATIONS));

  resetEntityRegistry();
  context = getEntityRegistry().register({
    agentName: 'winston',
    workspacePath,
    databasePath: join(tempDir, 'entities.db'),
  });

  const app = express();
  const { requireAgentBearer } = await import('../../src/middleware/bearer-auth.middleware');
  app.use('/api/agents/:agent/entities', requireAgentBearer, createEntitiesRoutes());
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalToken === undefined) {
    delete process.env['CLAWNDOM_AGENT_TOKEN'];
  } else {
    process.env['CLAWNDOM_AGENT_TOKEN'] = originalToken;
  }
  resetEntityRegistry();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('API-driven: full Heather cross-channel scenario over HTTP', () => {
  it('walks the whole flow: create entities, relate them, fetch by relation, audit', async () => {
    // === Step 1: create Heather over HTTP ===
    const heather = await apiCall('POST', '/api/agents/winston/entities/', {
      kind: 'team_member',
      name: 'Heather Hamilton',
      properties: {
        email: 'heather@talkatlanta.info',
        slack_user_id: 'U_HEATHER',
        role: 'Senior SLP',
        status: 'active',
      },
      id: 't_heather',
    });
    expect(heather.status).toBe(200);
    expect((heather.body['entity'] as { id: string }).id).toBe('t_heather');

    // === Step 2: create Bethany ===
    const bethany = await apiCall('POST', '/api/agents/winston/entities/', {
      kind: 'team_member',
      name: 'Bethany Morgado',
      properties: {
        email: 'bethany@talkatlanta.info',
        status: 'active',
      },
      id: 't_bethany',
    });
    expect(bethany.status).toBe(200);

    // === Step 3: create Camilla as Bethany's client ===
    const camilla = await apiCall('POST', '/api/agents/winston/entities/', {
      kind: 'client',
      name: 'Camilla Asher',
      properties: {
        legal_name: 'Camilla Asher',
        nickname: 'Camilla',
        date_of_birth: '2018-04-12',
        status: 'active',
      },
    });
    expect(camilla.status).toBe(200);
    const camillaId = (camilla.body['entity'] as { id: string }).id;
    expect(camillaId).toMatch(/^c_/);

    // === Step 4: relate Camilla → Bethany via has_therapist ===
    const relate = await apiCall('POST', `/api/agents/winston/entities/${camillaId}/relations`, {
      type: 'has_therapist',
      to_id: 't_bethany',
    });
    expect(relate.status).toBe(200);

    // === Step 5: find Bethany's clients by relation ===
    const bethanysClients = await apiCall(
      'GET',
      '/api/agents/winston/entities/?kinds=client&related_to=t_bethany&relation_type=has_therapist',
    );
    expect(bethanysClients.status).toBe(200);
    const clientList = bethanysClients.body['entities'] as Array<{ name: string }>;
    expect(clientList).toHaveLength(1);
    expect(clientList[0]!.name).toBe('Camilla Asher');

    // === Step 6: fetch Camilla with relations expanded ===
    const camillaExpanded = await apiCall(
      'GET',
      `/api/agents/winston/entities/${camillaId}?expand=relations`,
    );
    expect(camillaExpanded.status).toBe(200);
    const expanded = camillaExpanded.body['entity'] as {
      outgoing: Array<{ type: string; to_id: string }>;
    };
    expect(expanded.outgoing).toEqual([
      { type: 'has_therapist', to_id: 't_bethany', properties: null },
    ]);

    // === Step 7: write a memory entity related to Camilla ===
    const memory = await apiCall('POST', '/api/agents/winston/entities/', {
      kind: 'memory',
      name: 'family-moving-aug',
      properties: {
        text: "Camilla's family is moving in August",
        written_at: '2026-05-18',
        status: 'active',
      },
    });
    expect(memory.status).toBe(200);
    const memoryId = (memory.body['entity'] as { id: string }).id;
    await apiCall('POST', `/api/agents/winston/entities/${memoryId}/relations`, {
      type: 'memory_about',
      to_id: camillaId,
    });

    // === Step 8: recall memories about Camilla via find ===
    const memoriesAboutCamilla = await apiCall(
      'GET',
      `/api/agents/winston/entities/?kinds=memory&related_to=${camillaId}&relation_type=memory_about`,
    );
    expect(memoriesAboutCamilla.status).toBe(200);
    const memList = memoriesAboutCamilla.body['entities'] as Array<{
      properties: { text: string };
    }>;
    expect(memList).toHaveLength(1);
    expect(memList[0]!.properties.text).toContain('August');

    // === Step 9: read Camilla's audit log ===
    const audit = await apiCall('GET', `/api/agents/winston/entities/${camillaId}/audit`);
    expect(audit.status).toBe(200);
    const auditList = audit.body['audit'] as Array<{ op: string }>;
    expect(auditList.length).toBeGreaterThanOrEqual(2); // create + relate
    const ops = auditList.map((entry) => entry.op);
    expect(ops).toContain('create');
    expect(ops).toContain('relate');

    // === Step 10: unrelate Camilla from Bethany ===
    const unrelated = await apiCall(
      'DELETE',
      `/api/agents/winston/entities/${camillaId}/relations/has_therapist/t_bethany`,
    );
    expect(unrelated.status).toBe(200);
    const verifyEmpty = await apiCall(
      'GET',
      `/api/agents/winston/entities/?kinds=client&related_to=t_bethany&relation_type=has_therapist`,
    );
    expect(verifyEmpty.body['entities'] as unknown[]).toHaveLength(0);
  });

  it('rejects requests without bearer token', async () => {
    const result = await apiCall('GET', '/api/agents/winston/entities/', undefined, null);
    expect(result.status).toBe(401);
  });

  it('rejects requests with wrong bearer token', async () => {
    const result = await apiCall('GET', '/api/agents/winston/entities/', undefined, 'wrong-token');
    expect(result.status).toBe(401);
  });

  it('rejects schema-invalid upserts at the HTTP layer', async () => {
    const result = await apiCall('POST', '/api/agents/winston/entities/', {
      kind: 'team_member',
      name: 'Bad',
      properties: { email: 'not-an-email', status: 'active' },
    });
    expect(result.status).toBe(400);
    expect(result.body['code'] as string).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('FTS5 text_match works over HTTP', async () => {
    await apiCall('POST', '/api/agents/winston/entities/', {
      kind: 'memory',
      name: 'cancellation-policy',
      properties: {
        text: 'discussed cancellation policy with Heather',
        status: 'active',
      },
    });
    const result = await apiCall(
      'GET',
      '/api/agents/winston/entities/?kinds=memory&text_match=cancellation',
    );
    expect(result.status).toBe(200);
    expect(result.body['entities'] as unknown[]).toHaveLength(1);
  });

  it('time-based retrieval via order + limit', async () => {
    // Write three interactions with synthetic timestamps via the
    // service (the controller doesn't expose an order_dir=asc shortcut
    // for "since" queries; we use order=created_at desc + limit).
    for (let i = 0; i < 3; i++) {
      context.store.upsert('interaction', `i-${i}`, {
        inbound_text: `message ${i}`,
        outbound_summary: 'ack',
        surface: 'slack',
        route: 'slack.test',
        trace_id: `trc-${i}`,
      });
    }
    const result = await apiCall(
      'GET',
      '/api/agents/winston/entities/?kinds=interaction&order_field=created_at&order_dir=desc&limit=2',
    );
    expect(result.status).toBe(200);
    const list = result.body['entities'] as Array<{ name: string }>;
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe('i-2');
  });
});
