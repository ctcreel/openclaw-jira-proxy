import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Server } from 'node:http';

import express from 'express';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEntitiesRoutes } from '../../src/routes/entities.routes';
import {
  type AgentEntityContext,
  getEntityRegistry,
  resetEntityRegistry,
} from '../../src/services/entities/entity-registry';
import type { EntityKindSchema } from '../../src/services/entities/entity-schema.service';

let tempDir: string;
let workspacePath: string;
let context: AgentEntityContext;
let app: Express;
let server: Server;
let baseUrl: string;

const TEAM_SCHEMA: EntityKindSchema = {
  type: 'object',
  required: ['email', 'status'],
  properties: {
    email: { type: 'string', format: 'email' },
    role: { type: 'string' },
    status: { type: 'string', enum: ['active', 'departed', 'on_leave'] },
    slack_user_id: { type: 'string' },
  },
  'x-natural-keys': ['email'],
};

const CLIENT_SCHEMA: EntityKindSchema = {
  type: 'object',
  required: ['legal_name', 'status'],
  properties: {
    legal_name: { type: 'string' },
    nickname: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    date_of_birth: { type: 'string', format: 'date' },
    status: { type: 'string', enum: ['active', 'former', 'waitlist', 'discharged'] },
  },
  'x-natural-keys': ['legal_name', 'date_of_birth'],
};

function writeWorkspace(): void {
  const schemasDir = join(workspacePath, 'schemas');
  mkdirSync(schemasDir, { recursive: true });
  writeFileSync(join(schemasDir, 'team_member.schema.json'), JSON.stringify(TEAM_SCHEMA));
  writeFileSync(join(schemasDir, 'client.schema.json'), JSON.stringify(CLIENT_SCHEMA));
  writeFileSync(
    join(workspacePath, 'relations.json'),
    JSON.stringify({
      has_therapist: { from: 'client', to: 'team_member', description: 'assigned therapist' },
    }),
  );
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function httpRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${path}`);
    const requestObject = request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: Record<string, unknown> = {};
          if (raw !== '') {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { raw };
            }
          }
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
  tempDir = mkdtempSync(join(tmpdir(), 'clawndom-entities-ctrl-'));
  workspacePath = join(tempDir, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  writeWorkspace();
  resetEntityRegistry();
  context = getEntityRegistry().register({
    agentName: 'winston',
    workspacePath,
    databasePath: join(tempDir, 'entities.db'),
  });
  app = express();
  app.use('/api/agents/:agent/entities', createEntitiesRoutes());
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
  resetEntityRegistry();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('entities controller — upsert', () => {
  it('creates a new entity with operator-supplied slug ID', async () => {
    const result = await httpRequest('POST', '/api/agents/winston/entities/', {
      kind: 'team_member',
      name: 'Heather Hamilton',
      properties: {
        email: 'heather@talkatlanta.info',
        role: 'Senior SLP',
        status: 'active',
      },
      id: 't_heather',
    });
    expect(result.status).toBe(200);
    const entity = (result.body as { entity: { id: string; name: string } }).entity;
    expect(entity.id).toBe('t_heather');
    expect(entity.name).toBe('Heather Hamilton');
  });

  it('rejects an entity that fails schema validation', async () => {
    const result = await httpRequest('POST', '/api/agents/winston/entities/', {
      kind: 'team_member',
      name: 'Bad',
      properties: { email: 'not-an-email', status: 'active' },
    });
    expect(result.status).toBe(400);
    const body = result.body as { code?: string };
    expect(body.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('rejects a request missing required fields', async () => {
    const result = await httpRequest('POST', '/api/agents/winston/entities/', {
      name: 'No kind',
      properties: {},
    });
    expect(result.status).toBe(400);
  });

  it('returns 404 for unknown agent', async () => {
    const result = await httpRequest('POST', '/api/agents/no-such/entities/', {
      kind: 'team_member',
      name: 'X',
      properties: { email: 'x@x.com', status: 'active' },
    });
    expect(result.status).toBe(404);
  });
});

describe('entities controller — get and list', () => {
  beforeEach(() => {
    context.store.upsert(
      'team_member',
      'Heather',
      { email: 'heather@x.com', status: 'active', role: 'Senior SLP' },
      { id: 't_heather' },
    );
    context.store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
  });

  it('lists entities filtered by kind', async () => {
    const result = await httpRequest('GET', '/api/agents/winston/entities/?kinds=team_member');
    expect(result.status).toBe(200);
    const entities = (result.body as { entities: Array<{ kind: string }> }).entities;
    expect(entities).toHaveLength(1);
    expect(entities[0]!.kind).toBe('team_member');
  });

  it('fetches a single entity by ID', async () => {
    const result = await httpRequest('GET', '/api/agents/winston/entities/t_heather');
    expect(result.status).toBe(200);
    const entity = (result.body as { entity: { name: string } }).entity;
    expect(entity.name).toBe('Heather');
  });

  it('expands relations when asked', async () => {
    const camilla = context.store.find({ kinds: ['client'] })[0]!;
    context.store.relate(camilla.id, 'has_therapist', 't_heather');
    const result = await httpRequest(
      'GET',
      `/api/agents/winston/entities/${camilla.id}?expand=relations`,
    );
    expect(result.status).toBe(200);
    const entity = result.body['entity'] as { outgoing: Array<{ to_id: string }> };
    expect(entity.outgoing).toEqual([
      { type: 'has_therapist', to_id: 't_heather', properties: null },
    ]);
  });

  it('returns 404 for unknown entity', async () => {
    const result = await httpRequest('GET', '/api/agents/winston/entities/no-such-id');
    expect(result.status).toBe(404);
  });
});

describe('entities controller — relate and unrelate', () => {
  it('relate succeeds with both entities present', async () => {
    context.store.upsert(
      'team_member',
      'Heather',
      { email: 'h@x.com', status: 'active' },
      { id: 't_heather' },
    );
    const client = context.store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    const result = await httpRequest(
      'POST',
      `/api/agents/winston/entities/${client.id}/relations`,
      {
        type: 'has_therapist',
        to_id: 't_heather',
      },
    );
    expect(result.status).toBe(200);
  });

  it('relate fails when target is missing', async () => {
    const client = context.store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    const result = await httpRequest(
      'POST',
      `/api/agents/winston/entities/${client.id}/relations`,
      {
        type: 'has_therapist',
        to_id: 'nonexistent',
      },
    );
    expect(result.status).toBe(400);
  });

  it('unrelate removes the relation', async () => {
    context.store.upsert(
      'team_member',
      'Heather',
      { email: 'h@x.com', status: 'active' },
      { id: 't_heather' },
    );
    const client = context.store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    context.store.relate(client.id, 'has_therapist', 't_heather');
    const result = await httpRequest(
      'DELETE',
      `/api/agents/winston/entities/${client.id}/relations/has_therapist/t_heather`,
    );
    expect(result.status).toBe(200);
    const remaining = context.store.get(client.id, { expand_relations: true });
    expect(remaining?.outgoing).toHaveLength(0);
  });
});

describe('entities controller — list query parameters', () => {
  beforeEach(() => {
    context.store.upsert(
      'team_member',
      'Heather',
      { email: 'h@x.com', status: 'active' },
      { id: 't_heather' },
    );
    context.store.upsert(
      'team_member',
      'Departed',
      { email: 'd@x.com', status: 'departed' },
      { id: 't_departed' },
    );
    context.store.upsert('client', 'Alan', {
      legal_name: 'Alan Hu',
      date_of_birth: '2018-04-12',
      aliases: ['AIS AH'],
      status: 'active',
    });
  });

  it('filters by status', async () => {
    const result = await httpRequest('GET', '/api/agents/winston/entities/?status=active');
    expect(result.status).toBe(200);
    const entities = (result.body as { entities: unknown[] }).entities;
    expect(entities).toHaveLength(2);
  });

  it('matches q against name/alias', async () => {
    const result = await httpRequest('GET', '/api/agents/winston/entities/?kinds=client&q=AIS');
    expect(result.status).toBe(200);
    const entities = (result.body as { entities: Array<{ name: string }> }).entities;
    expect(entities[0]!.name).toBe('Alan');
  });

  it('honors order_field + order_dir + limit', async () => {
    const result = await httpRequest(
      'GET',
      '/api/agents/winston/entities/?kinds=team_member&order_field=name&order_dir=asc&limit=1',
    );
    expect(result.status).toBe(200);
    const entities = (result.body as { entities: Array<{ name: string }> }).entities;
    expect(entities).toHaveLength(1);
    expect(entities[0]!.name).toBe('Departed');
  });

  it('ignores invalid order values gracefully', async () => {
    const result = await httpRequest(
      'GET',
      '/api/agents/winston/entities/?kinds=team_member&order_field=garbage&order_dir=garbage',
    );
    expect(result.status).toBe(200);
    expect((result.body as { entities: unknown[] }).entities).toHaveLength(2);
  });

  it('ignores invalid limit values', async () => {
    const result = await httpRequest(
      'GET',
      '/api/agents/winston/entities/?kinds=team_member&limit=notanumber',
    );
    expect(result.status).toBe(200);
  });

  it('filters by related_to + relation_type', async () => {
    const camilla = context.store.find({ kinds: ['client'] })[0]!;
    context.store.relate(camilla.id, 'has_therapist', 't_heather');
    const result = await httpRequest(
      'GET',
      `/api/agents/winston/entities/?kinds=client&related_to=t_heather&relation_type=has_therapist`,
    );
    expect(result.status).toBe(200);
    expect((result.body as { entities: unknown[] }).entities).toHaveLength(1);
  });

  it('text_match via FTS5', async () => {
    context.store.upsert('memory', 'note-1', {
      text: 'discussed cancellation policy',
      status: 'active',
    });
    const result = await httpRequest(
      'GET',
      '/api/agents/winston/entities/?kinds=memory&text_match=cancellation',
    );
    expect(result.status).toBe(200);
    expect((result.body as { entities: unknown[] }).entities).toHaveLength(1);
  });
});

describe('entities controller — error paths', () => {
  it('rejects relate with missing :id', async () => {
    // Express won't match without :id, but the registry-404 path is hit
    // for the parent route — test the unrelate path which has multiple
    // required params.
    const result = await httpRequest(
      'DELETE',
      '/api/agents/winston/entities/no-such-id/relations/has_therapist/also-not-real',
    );
    // unrelate is forgiving by design (no error if relation not present)
    expect(result.status).toBe(200);
  });

  it('handles malformed JSON body gracefully', async () => {
    // Build a raw request with bad JSON
    const { request } = await import('node:http');
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${baseUrl}/api/agents/winston/entities/`);
      const requestObject = request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            }),
          );
        },
      );
      requestObject.on('error', reject);
      requestObject.write('{ not json');
      requestObject.end();
    });
    expect(result.status).toBe(400);
  });
});

describe('entities controller — audit', () => {
  it('returns the audit log for an entity', async () => {
    const team = context.store.upsert(
      'team_member',
      'Heather',
      { email: 'h@x.com', status: 'active' },
      { id: 't_heather' },
    );
    const result = await httpRequest('GET', `/api/agents/winston/entities/${team.id}/audit`);
    expect(result.status).toBe(200);
    const audit = result.body['audit'] as Array<{ op: string }>;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]!.op).toBe('create');
  });
});
