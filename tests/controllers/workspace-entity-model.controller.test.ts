import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';

import { createWorkspaceEntityModelHandler } from '../../src/controllers/workspace-entity-model.controller';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';
import {
  EntityRegistry,
  type AgentEntityContext,
} from '../../src/services/entities/entity-registry';
import type { EntityKindSchema } from '../../src/services/entities/entity-schema.service';

let tempDir: string;
let workspacePath: string;
let registry: EntityRegistry;
let context: AgentEntityContext;

const SCHEMAS: Record<string, EntityKindSchema> = {
  client: {
    type: 'object',
    description: 'A person receiving therapy.',
    required: ['legal_name', 'status'],
    properties: {
      legal_name: { type: 'string' },
      status: { type: 'string', enum: ['active', 'former'] },
    },
    'x-natural-keys': ['legal_name'],
  },
  team_member: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email' },
    },
    'x-natural-keys': ['email'],
  },
};

const RELATIONS = {
  has_therapist: { from: 'client', to: 'team_member', description: 'assigned therapist' },
};

interface FakeResponse {
  statusCode: number;
  body: unknown;
}

function makeRequest(agent: string | undefined): Request {
  return { params: agent === undefined ? {} : { agent } } as unknown as Request;
}

function makeResponse(): { response: Response; result: FakeResponse } {
  const result: FakeResponse = { statusCode: 0, body: null };
  const fake = {
    status(code: number): unknown {
      result.statusCode = code;
      return this;
    },
    json(payload: unknown): unknown {
      result.body = payload;
      return this;
    },
  };
  return { response: fake as unknown as Response, result };
}

function makeAgent(name: string, rules: ReadonlyArray<unknown>): ResolvedAgent {
  return {
    name,
    agentDir: '/tmp/fake',
    config: { routing: { slack: { rules } } },
  } as unknown as ResolvedAgent;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clawndom-ws-entity-model-'));
  workspacePath = join(tempDir, 'workspace');
  const schemasDir = join(workspacePath, 'schemas');
  mkdirSync(schemasDir, { recursive: true });
  for (const [kind, schema] of Object.entries(SCHEMAS)) {
    writeFileSync(join(schemasDir, `${kind}.schema.json`), JSON.stringify(schema));
  }
  writeFileSync(join(workspacePath, 'relations.json'), JSON.stringify(RELATIONS));
  registry = new EntityRegistry();
  context = registry.register({
    agentName: 'winston',
    workspacePath,
    databasePath: join(tempDir, 'entities.db'),
  });
});

afterEach(() => {
  registry.closeAll();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createWorkspaceEntityModelHandler', () => {
  it('returns kinds, relations, and rules referencing entities', () => {
    const agents = [
      makeAgent('winston', [
        { id: 'chat', name: 'chat', entities: { kinds: ['client', 'team_member'] } },
        { id: 'refresh-tokens' }, // no entities — should be excluded
      ]),
    ];
    const handler = createWorkspaceEntityModelHandler(agents, registry);
    const { response, result } = makeResponse();
    handler(makeRequest('winston'), response);
    expect(result.statusCode).toBe(200);
    const payload = result.body as {
      agent: string;
      kinds: Array<{ kind: string }>;
      relations: Record<string, unknown>;
      rules: Array<{ ruleId: string; entities: { kinds: string[] } }>;
    };
    expect(payload.agent).toBe('winston');
    expect(payload.kinds.map((k) => k.kind).sort()).toEqual(['client', 'team_member']);
    expect(payload.relations['has_therapist']).toBeDefined();
    expect(payload.rules).toHaveLength(1);
    expect(payload.rules[0]!.ruleId).toBe('chat');
    expect(payload.rules[0]!.entities.kinds).toEqual(['client', 'team_member']);
  });

  it('returns 400 when :agent is missing', () => {
    const handler = createWorkspaceEntityModelHandler([], registry);
    const { response, result } = makeResponse();
    handler(makeRequest(undefined), response);
    expect(result.statusCode).toBe(400);
  });

  it('returns 404 when the agent has no entity store', () => {
    const handler = createWorkspaceEntityModelHandler([], registry);
    const { response, result } = makeResponse();
    handler(makeRequest('nonexistent'), response);
    expect(result.statusCode).toBe(404);
  });

  it('handles agents with no rules referencing entities', () => {
    const agents = [makeAgent('winston', [{ id: 'no-entities' }])];
    const handler = createWorkspaceEntityModelHandler(agents, registry);
    const { response, result } = makeResponse();
    handler(makeRequest('winston'), response);
    expect(result.statusCode).toBe(200);
    const payload = result.body as { rules: unknown[] };
    expect(payload.rules).toEqual([]);
  });

  it('handles agents not in the agents list', () => {
    const handler = createWorkspaceEntityModelHandler([], registry);
    const { response, result } = makeResponse();
    handler(makeRequest('winston'), response);
    expect(result.statusCode).toBe(200);
    const payload = result.body as { rules: unknown[]; kinds: unknown[] };
    expect(payload.rules).toEqual([]);
    expect(payload.kinds).toHaveLength(2);
    void context;
  });

  it('full kind schema content is in the payload (UI form rendering)', () => {
    const agents = [makeAgent('winston', [])];
    const handler = createWorkspaceEntityModelHandler(agents, registry);
    const { response, result } = makeResponse();
    handler(makeRequest('winston'), response);
    const payload = result.body as { kinds: Array<{ kind: string; schema: unknown }> };
    const clientEntry = payload.kinds.find((k) => k.kind === 'client');
    expect(clientEntry).toBeDefined();
    const clientSchema = clientEntry!.schema as { description: string; properties: object };
    expect(clientSchema.description).toContain('therapy');
    expect(clientSchema.properties).toBeDefined();
  });
});
