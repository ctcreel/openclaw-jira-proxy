import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getEntityRegistry,
  resetEntityRegistry,
} from '../../../src/services/entities/entity-registry';
import type { EntityKindSchema } from '../../../src/services/entities/entity-schema.service';
import { EntityWorkerIntegration } from '../../../src/services/entities/entity-worker-integration.service';

let tempDir: string;
let workspacePath: string;
let integration: EntityWorkerIntegration;

const SCHEMAS_WITHOUT_INTERACTION: Record<string, EntityKindSchema> = {
  team_member: {
    type: 'object',
    required: ['email', 'status'],
    properties: {
      email: { type: 'string', format: 'email' },
      status: { type: 'string', enum: ['active'] },
    },
    'x-natural-keys': ['email'],
  },
};

const SCHEMAS_WITH_INTERACTION: Record<string, EntityKindSchema> = {
  team_member: {
    type: 'object',
    required: ['email', 'status'],
    properties: {
      email: { type: 'string', format: 'email' },
      slack_user_id: { type: 'string' },
      status: { type: 'string', enum: ['active'] },
    },
    'x-natural-keys': ['email'],
  },
  contact: {
    type: 'object',
    required: ['status'],
    properties: {
      email: { type: 'string', format: 'email' },
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

function writeSchemas(target: Record<string, EntityKindSchema>): void {
  const schemasDir = join(workspacePath, 'schemas');
  mkdirSync(schemasDir, { recursive: true });
  for (const [kind, schema] of Object.entries(target)) {
    writeFileSync(join(schemasDir, `${kind}.schema.json`), JSON.stringify(schema));
  }
  writeFileSync(
    join(workspacePath, 'relations.json'),
    JSON.stringify({
      has_contact: { from: 'client', to: 'contact' },
      from: { from: 'interaction', to: 'team_member' },
      about: { from: 'interaction', to: 'client' },
    }),
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clawndom-entity-worker-'));
  workspacePath = join(tempDir, 'workspace');
  resetEntityRegistry();
});

afterEach(() => {
  resetEntityRegistry();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('EntityWorkerIntegration branch coverage', () => {
  it('returns null actor for unknown agent', () => {
    writeSchemas(SCHEMAS_WITHOUT_INTERACTION);
    getEntityRegistry().register({
      agentName: 'winston',
      workspacePath,
      databasePath: join(tempDir, 'entities.db'),
    });
    integration = new EntityWorkerIntegration(getEntityRegistry());
    const actor = integration.resolveActor('unknown-agent', {
      identityHints: { email: 'x@x.com' },
    });
    expect(actor).toBeNull();
  });

  it('skips interaction write when interaction kind has no schema', () => {
    writeSchemas(SCHEMAS_WITHOUT_INTERACTION);
    getEntityRegistry().register({
      agentName: 'winston',
      workspacePath,
      databasePath: join(tempDir, 'entities.db'),
    });
    const context = getEntityRegistry().get('winston')!;
    context.store.upsert('team_member', 'X', { email: 'x@x.com', status: 'active' }, { id: 't_x' });
    integration = new EntityWorkerIntegration(getEntityRegistry());
    const actor = integration.resolveActor('winston', { identityHints: { email: 'x@x.com' } })!;
    const result = integration.recordInteraction('winston', actor, {
      inbound_text: 'hello',
      outbound_summary: 'hi',
      surface: 'slack',
      route: 'slack.test',
      trace_id: 'trc',
    });
    expect(result.interactionId).toBeNull();
  });

  it('recordInteraction on unknown agent returns null result', () => {
    writeSchemas(SCHEMAS_WITH_INTERACTION);
    getEntityRegistry().register({
      agentName: 'winston',
      workspacePath,
      databasePath: join(tempDir, 'entities.db'),
    });
    integration = new EntityWorkerIntegration(getEntityRegistry());
    const fakeStranger = { kind: 'stranger' as const, id: null, email: 'x@x.com' };
    const result = integration.recordInteraction('unknown-agent', fakeStranger, {
      inbound_text: 'hi',
      outbound_summary: 'hi',
      surface: 'slack',
      route: 'slack.test',
      trace_id: 'trc',
    });
    expect(result.interactionId).toBeNull();
  });

  it('fetchRecentInteractions returns empty for unknown agent', () => {
    writeSchemas(SCHEMAS_WITH_INTERACTION);
    getEntityRegistry().register({
      agentName: 'winston',
      workspacePath,
      databasePath: join(tempDir, 'entities.db'),
    });
    integration = new EntityWorkerIntegration(getEntityRegistry());
    const result = integration.fetchRecentInteractions(
      'unknown',
      { kind: 'team_member', id: 't_x', name: 'X' },
      { topN: 5 },
    );
    expect(result).toEqual([]);
  });

  it('fetchRecentInteractions returns empty when interaction kind not schema-declared', () => {
    writeSchemas(SCHEMAS_WITHOUT_INTERACTION);
    getEntityRegistry().register({
      agentName: 'winston',
      workspacePath,
      databasePath: join(tempDir, 'entities.db'),
    });
    integration = new EntityWorkerIntegration(getEntityRegistry());
    const result = integration.fetchRecentInteractions(
      'winston',
      { kind: 'team_member', id: 't_x', name: 'X' },
      { topN: 5 },
    );
    expect(result).toEqual([]);
  });

  it('truncates long outbound summary', () => {
    writeSchemas(SCHEMAS_WITH_INTERACTION);
    getEntityRegistry().register({
      agentName: 'winston',
      workspacePath,
      databasePath: join(tempDir, 'entities.db'),
    });
    const context = getEntityRegistry().get('winston')!;
    context.store.upsert('team_member', 'X', { email: 'x@x.com', status: 'active' }, { id: 't_x' });
    integration = new EntityWorkerIntegration(getEntityRegistry());
    const actor = integration.resolveActor('winston', { identityHints: { email: 'x@x.com' } })!;
    const longText = 'a'.repeat(600);
    const result = integration.recordInteraction('winston', actor, {
      inbound_text: 'short',
      outbound_summary: longText,
      surface: 'slack',
      route: 'slack.test',
      trace_id: 'trc',
    });
    expect(result.interactionId).not.toBeNull();
    const interaction = context.store.get(result.interactionId!);
    expect(interaction!.properties['outbound_summary']).toMatch(/^a{500}\.\.\.$/);
  });

  it('respects includeMentionsOfRelatedEntities flag for contact actors', () => {
    writeSchemas(SCHEMAS_WITH_INTERACTION);
    getEntityRegistry().register({
      agentName: 'winston',
      workspacePath,
      databasePath: join(tempDir, 'entities.db'),
    });
    const context = getEntityRegistry().get('winston')!;
    const camilla = context.store.upsert('client', 'Camilla', {
      legal_name: 'Camilla A',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    const sarah = context.store.upsert('contact', 'Sarah', {
      email: 'sarah@x.com',
      status: 'active',
    });
    context.store.relate(camilla.id, 'has_contact', sarah.id);
    integration = new EntityWorkerIntegration(getEntityRegistry());

    // Write an interaction about Camilla (without Sarah as from)
    const team = context.store.upsert(
      'team_member',
      'Heather',
      { email: 'h@x.com', status: 'active' },
      { id: 't_h' },
    );
    const heatherActor = integration.resolveActor('winston', {
      identityHints: { email: 'h@x.com' },
    })!;
    integration.recordInteraction('winston', heatherActor, {
      inbound_text: 'Camilla note from Heather',
      outbound_summary: 'noted',
      surface: 'slack',
      route: 'slack.chat',
      trace_id: 'trc-1',
    });

    // Now resolve Sarah and fetch with the related-entities flag
    const sarahActor = integration.resolveActor('winston', {
      identityHints: { email: 'sarah@x.com' },
    })!;
    expect(sarahActor.id).toBe(sarah.id);
    const recentBasic = integration.fetchRecentInteractions('winston', sarahActor, {
      topN: 5,
    });
    expect(recentBasic).toHaveLength(0);
    const recentEnriched = integration.fetchRecentInteractions('winston', sarahActor, {
      topN: 5,
      includeMentionsOfRelatedEntities: true,
    });
    expect(recentEnriched.length).toBeGreaterThan(0);
    void team;
  });
});
