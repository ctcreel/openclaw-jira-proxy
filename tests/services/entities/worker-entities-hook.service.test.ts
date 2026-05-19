import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getEntityRegistry,
  resetEntityRegistry,
} from '../../../src/services/entities/entity-registry';
import type { EntityKindSchema } from '../../../src/services/entities/entity-schema.service';
import { WorkerEntitiesHook } from '../../../src/services/entities/worker-entities-hook.service';

let tempDir: string;
let workspacePath: string;
let hook: WorkerEntitiesHook;

const SCHEMAS: Record<string, EntityKindSchema> = {
  team_member: {
    type: 'object',
    required: ['email', 'status'],
    properties: {
      email: { type: 'string', format: 'email' },
      slack_user_id: { type: 'string' },
      role: { type: 'string' },
      status: { type: 'string', enum: ['active'] },
    },
    'x-natural-keys': ['email'],
  },
  client: {
    type: 'object',
    required: ['legal_name', 'status'],
    properties: {
      legal_name: { type: 'string' },
      date_of_birth: { type: 'string', format: 'date' },
      status: { type: 'string', enum: ['active'] },
    },
    'x-natural-keys': ['legal_name', 'date_of_birth'],
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clawndom-worker-hook-'));
  workspacePath = join(tempDir, 'workspace');
  const schemasDir = join(workspacePath, 'schemas');
  mkdirSync(schemasDir, { recursive: true });
  for (const [kind, schema] of Object.entries(SCHEMAS)) {
    writeFileSync(join(schemasDir, `${kind}.schema.json`), JSON.stringify(schema));
  }
  writeFileSync(
    join(workspacePath, 'relations.json'),
    JSON.stringify({
      from: { from: 'interaction', to: 'team_member' },
      about: { from: 'interaction', to: 'client' },
    }),
  );
  resetEntityRegistry();
  const context = getEntityRegistry().register({
    agentName: 'winston',
    workspacePath,
    databasePath: join(tempDir, 'entities.db'),
  });
  context.store.upsert(
    'team_member',
    'Heather',
    {
      email: 'heather@talkatlanta.info',
      slack_user_id: 'U_HEATHER',
      role: 'Senior SLP',
      status: 'active',
    },
    { id: 't_heather' },
  );
  hook = new WorkerEntitiesHook(getEntityRegistry());
});

afterEach(() => {
  resetEntityRegistry();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('WorkerEntitiesHook.prepare', () => {
  it('returns empty when agent has no entity registration', () => {
    resetEntityRegistry();
    const isolatedHook = new WorkerEntitiesHook(getEntityRegistry());
    const result = isolatedHook.prepare(
      { entities: { kinds: ['team_member'] } },
      { agentName: 'no-such-agent', providerName: 'slack', ruleName: 'chat', traceId: 't' },
      { event: { user: 'U_X' } },
    );
    expect(result.actor).toBeNull();
    expect(result.entity_model).toBeUndefined();
  });

  it('returns empty when rule does not declare entities.kinds', () => {
    const result = hook.prepare(
      {},
      { agentName: 'winston', providerName: 'slack', ruleName: 'chat', traceId: 't' },
      { event: { user: 'U_HEATHER' } },
    );
    expect(result.entity_model).toBeUndefined();
  });

  it('resolves actor from Slack hint and emits entity_model', () => {
    const result = hook.prepare(
      { entities: { kinds: ['team_member'] } },
      { agentName: 'winston', providerName: 'slack-winston', ruleName: 'chat', traceId: 't' },
      { event: { user: 'U_HEATHER', type: 'message' } },
    );
    expect(result.actor).not.toBeNull();
    expect(result.actor!.id).toBe('t_heather');
    expect(result.entity_model).toContain('### team_member');
  });

  it('resolves actor from Gmail "Name <email>" + emits entity_model', () => {
    const result = hook.prepare(
      { entities: { kinds: ['team_member'] } },
      {
        agentName: 'winston',
        providerName: 'gmail-pubsub',
        ruleName: 'email-chat',
        traceId: 't',
      },
      { from: 'Heather Hamilton <heather@talkatlanta.info>' },
    );
    expect(result.actor!.id).toBe('t_heather');
  });

  it('does not auto-fetch interactions (retrieval is template-driven)', () => {
    // Record an interaction via the post-turn hook
    const firstActor = hook.prepare(
      { entities: { kinds: ['team_member', 'interaction'] } },
      { agentName: 'winston', providerName: 'slack-winston', ruleName: 'chat', traceId: 't1' },
      { event: { user: 'U_HEATHER' } },
    ).actor;
    expect(firstActor).not.toBeNull();
    hook.recordTurn(
      { entities: { kinds: ['team_member', 'interaction'] } },
      { agentName: 'winston', providerName: 'slack-winston', ruleName: 'chat', traceId: 't1' },
      firstActor,
      'hello',
      'hi back',
    );

    // Subsequent prepare must NOT pre-populate interactions — that's
    // the agent's job via the history/recall tools.
    const result = hook.prepare(
      { entities: { kinds: ['team_member', 'interaction'] } },
      { agentName: 'winston', providerName: 'slack-winston', ruleName: 'chat', traceId: 't2' },
      { event: { user: 'U_HEATHER' } },
    );
    expect('interactions' in result).toBe(false);
    expect(result.actor).not.toBeNull();
    expect(result.entity_model).toBeDefined();
  });
});

describe('WorkerEntitiesHook.recordTurn', () => {
  it('writes interaction entity with from relation', () => {
    const actor = hook.prepare(
      { entities: { kinds: ['team_member'] } },
      { agentName: 'winston', providerName: 'slack-winston', ruleName: 'chat', traceId: 't' },
      { event: { user: 'U_HEATHER' } },
    ).actor;
    hook.recordTurn(
      { entities: { kinds: ['team_member', 'interaction'] } },
      { agentName: 'winston', providerName: 'slack-winston', ruleName: 'chat', traceId: 't' },
      actor,
      'hey winston',
      'hey heather',
    );
    const interactions = getEntityRegistry()
      .get('winston')!
      .store.find({ kinds: ['interaction'] });
    expect(interactions).toHaveLength(1);
  });

  it('no-ops on null actor', () => {
    hook.recordTurn(
      { entities: { kinds: ['team_member'] } },
      { agentName: 'winston', providerName: 'slack-winston', ruleName: 'chat', traceId: 't' },
      null,
      'x',
      'y',
    );
    const interactions = getEntityRegistry()
      .get('winston')!
      .store.find({ kinds: ['interaction'] });
    expect(interactions).toHaveLength(0);
  });

  it('no-ops when rule does not declare entities', () => {
    const actor = { kind: 'team_member', id: 't_heather', name: 'Heather' };
    hook.recordTurn(
      {},
      { agentName: 'winston', providerName: 'slack-winston', ruleName: 'chat', traceId: 't' },
      actor,
      'x',
      'y',
    );
    const interactions = getEntityRegistry()
      .get('winston')!
      .store.find({ kinds: ['interaction'] });
    expect(interactions).toHaveLength(0);
  });
});
