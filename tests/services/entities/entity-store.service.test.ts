import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EntityStore, EntityStoreError } from '../../../src/services/entities/entity-store.service';

let tempDir: string;
let store: EntityStore;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clawndom-entity-store-'));
  dbPath = join(tempDir, 'entities.db');
  store = new EntityStore({
    filePath: dbPath,
    naturalKeys: {
      team_member: {
        fields: ['email'],
        normalize: (v): string | null => (typeof v === 'string' ? v.trim().toLowerCase() : null),
      },
      client: {
        fields: ['legal_name', 'date_of_birth'],
        normalize: (v): string | null => (typeof v === 'string' ? v.trim().toLowerCase() : null),
      },
      contact: {
        fields: ['email'],
        normalize: (v): string | null => (typeof v === 'string' ? v.trim().toLowerCase() : null),
      },
    },
  });
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('EntityStore.upsert', () => {
  it('creates a new entity when no natural-key match', () => {
    const result = store.upsert('team_member', 'Heather Hamilton', {
      email: 'heather@talkatlanta.info',
      role: 'Senior SLP',
      status: 'active',
    });
    expect(result.id).toBeTruthy();
    expect(result.kind).toBe('team_member');
    expect(result.name).toBe('Heather Hamilton');
    expect(result.properties.email).toBe('heather@talkatlanta.info');
    expect(result.created_at).toBe(result.updated_at);
  });

  it('updates existing entity on natural-key match', () => {
    const first = store.upsert('team_member', 'Heather Hamilton', {
      email: 'heather@talkatlanta.info',
      role: 'SLP',
      status: 'active',
    });
    const second = store.upsert('team_member', 'Heather H.', {
      email: 'HEATHER@talkatlanta.info',
      role: 'Senior SLP',
      status: 'active',
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Heather H.');
    expect(second.properties.role).toBe('Senior SLP');
    expect(second.updated_at).toBeGreaterThanOrEqual(first.created_at);
  });

  it('honors operator-supplied ID', () => {
    const result = store.upsert(
      'team_member',
      'Bethany Morgado',
      { email: 'bethany@talkatlanta.info', status: 'active' },
      { id: 't_bethany' },
    );
    expect(result.id).toBe('t_bethany');
  });

  it('last-writer-wins: replaces properties wholesale on update', () => {
    const first = store.upsert('team_member', 'Heather', {
      email: 'h@x.com',
      role: 'SLP',
      status: 'active',
      extra: 'keepme',
    });
    const second = store.upsert(
      'team_member',
      'Heather',
      { email: 'h@x.com', role: 'Senior SLP', status: 'active' },
      { id: first.id },
    );
    expect(second.properties.extra).toBeUndefined();
    expect(second.properties.role).toBe('Senior SLP');
  });

  it('throws when kind is missing', () => {
    expect(() => store.upsert('', 'name', {})).toThrow(EntityStoreError);
  });

  it('writes an audit row for every create + update', () => {
    const created = store.upsert(
      'team_member',
      'Heather',
      { email: 'h@x.com', status: 'active' },
      { trace_id: 'trc-1', actor: 'tool:entity.upsert' },
    );
    store.upsert(
      'team_member',
      'Heather',
      { email: 'h@x.com', status: 'on_leave' },
      { id: created.id, trace_id: 'trc-2', actor: 'tool:entity.upsert' },
    );
    const audit = store.auditFor(created.id);
    expect(audit).toHaveLength(2);
    expect(audit[0]!.op).toBe('update');
    expect(audit[1]!.op).toBe('create');
    expect(audit[0]!.trace_id).toBe('trc-2');
  });
});

describe('EntityStore.get', () => {
  it('returns null for missing entity', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('returns entity by id', () => {
    const created = store.upsert('team_member', 'Heather', {
      email: 'h@x.com',
      status: 'active',
    });
    const fetched = store.get(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.name).toBe('Heather');
  });

  it('expands relations when requested', () => {
    const team = store.upsert('team_member', 'Heather', {
      email: 'h@x.com',
      status: 'active',
    });
    const client = store.upsert('client', 'Ari Goolsby', {
      legal_name: 'Ariel Goolsby',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    store.relate(client.id, 'has_therapist', team.id);
    const expanded = store.get(client.id, { expand_relations: true });
    expect(expanded?.outgoing).toEqual([
      { type: 'has_therapist', to_id: team.id, properties: null },
    ]);
    expect(expanded?.incoming).toEqual([]);
    const expandedTeam = store.get(team.id, { expand_relations: true });
    expect(expandedTeam?.incoming).toEqual([
      { type: 'has_therapist', from_id: client.id, properties: null },
    ]);
  });
});

describe('EntityStore.find', () => {
  it('filters by kind', () => {
    store.upsert('team_member', 'Heather', { email: 'h@x.com', status: 'active' });
    store.upsert('client', 'Ari', {
      legal_name: 'Ariel Goolsby',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    const teamOnly = store.find({ kinds: ['team_member'] });
    expect(teamOnly).toHaveLength(1);
    expect(teamOnly[0]!.kind).toBe('team_member');
  });

  it('filters by status', () => {
    store.upsert('team_member', 'Active1', { email: 'a@x.com', status: 'active' });
    store.upsert('team_member', 'Departed', { email: 'd@x.com', status: 'departed' });
    const actives = store.find({ kinds: ['team_member'], status: 'active' });
    expect(actives).toHaveLength(1);
    expect(actives[0]!.name).toBe('Active1');
  });

  it('matches q against name and aliases', () => {
    store.upsert('client', 'Alan Hu', {
      legal_name: 'Alan Hu',
      date_of_birth: '2018-04-12',
      aliases: ['AIS AH'],
      status: 'active',
    });
    const byName = store.find({ kinds: ['client'], q: 'Alan' });
    expect(byName).toHaveLength(1);
    const byAlias = store.find({ kinds: ['client'], q: 'AIS' });
    expect(byAlias).toHaveLength(1);
    expect(byAlias[0]!.name).toBe('Alan Hu');
  });

  it('filters by related_to + relation_type', () => {
    const team = store.upsert('team_member', 'Bethany', {
      email: 'b@x.com',
      status: 'active',
    });
    const client = store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    const other = store.upsert('client', 'Other', {
      legal_name: 'Other Kid',
      date_of_birth: '2019-01-01',
      status: 'active',
    });
    store.relate(client.id, 'has_therapist', team.id);
    store.relate(other.id, 'has_therapist', team.id);
    const bethanyClients = store.find({
      kinds: ['client'],
      related_to: team.id,
      relation_type: 'has_therapist',
    });
    expect(bethanyClients).toHaveLength(2);
    expect(bethanyClients.map((e) => e.name).sort()).toEqual(['Camilla', 'Other']);
  });

  it('respects order and limit', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const entity = store.upsert('team_member', `T${i}`, {
        email: `t${i}@x.com`,
        status: 'active',
      });
      ids.push(entity.id);
    }
    const recent = store.find({
      kinds: ['team_member'],
      order: { field: 'created_at', dir: 'desc' },
      limit: 2,
    });
    expect(recent).toHaveLength(2);
    expect(recent[0]!.name).toBe('T4');
    expect(recent[1]!.name).toBe('T3');
  });

  it('supports text_match via FTS5', () => {
    store.upsert('memory', 'memory-1', {
      text: 'family is moving in August',
      status: 'active',
    });
    store.upsert('memory', 'memory-2', {
      text: 'discussed cancellation policy',
      status: 'active',
    });
    const matches = store.find({ kinds: ['memory'], text_match: 'cancellation' });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.properties.text as string).toContain('cancellation');
  });
});

describe('EntityStore.relate / unrelate', () => {
  it('idempotent relate (second identical call is no-op)', () => {
    const team = store.upsert('team_member', 'Bethany', {
      email: 'b@x.com',
      status: 'active',
    });
    const client = store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    store.relate(client.id, 'has_therapist', team.id);
    store.relate(client.id, 'has_therapist', team.id);
    const expanded = store.get(client.id, { expand_relations: true });
    expect(expanded?.outgoing).toHaveLength(1);
  });

  it('relation properties preserved', () => {
    const client = store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    const contact = store.upsert('contact', 'Sarah', {
      email: 's@x.com',
      status: 'active',
    });
    store.relate(client.id, 'has_contact', contact.id, { priority: 'primary' });
    const expanded = store.get(client.id, { expand_relations: true });
    expect(expanded?.outgoing?.[0]!.properties).toEqual({ priority: 'primary' });
  });

  it('rejects relations to non-existent entities', () => {
    const team = store.upsert('team_member', 'Bethany', {
      email: 'b@x.com',
      status: 'active',
    });
    expect(() => store.relate('nonexistent', 'has_therapist', team.id)).toThrow(EntityStoreError);
  });

  it('unrelate removes the relation', () => {
    const team = store.upsert('team_member', 'Bethany', {
      email: 'b@x.com',
      status: 'active',
    });
    const client = store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    store.relate(client.id, 'has_therapist', team.id);
    store.unrelate(client.id, 'has_therapist', team.id);
    const expanded = store.get(client.id, { expand_relations: true });
    expect(expanded?.outgoing).toHaveLength(0);
  });
});

describe('EntityStore.purge', () => {
  it('hard-deletes the entity and all relations touching it (incoming and outgoing)', () => {
    const team = store.upsert('team_member', 'Bethany', {
      email: 'b@x.com',
      status: 'active',
    });
    const client = store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    const contact = store.upsert('contact', 'Sarah', {
      email: 's@x.com',
      status: 'active',
    });
    store.relate(client.id, 'has_therapist', team.id);
    store.relate(client.id, 'has_contact', contact.id, { priority: 'primary' });
    store.purge(contact.id, 'test cleanup');
    expect(store.get(contact.id)).toBeNull();
    // incoming relation (client --has_contact-> contact) is severed too,
    // recorded in the audit log but removed from the relations table
    const incoming = store.database
      .prepare('SELECT COUNT(*) AS n FROM relations WHERE to_id = ?')
      .get(contact.id) as { n: number };
    expect(incoming.n).toBe(0);
    // and the client's other (unrelated) outgoing relation is intact
    const remaining = store.database
      .prepare('SELECT COUNT(*) AS n FROM relations WHERE from_id = ?')
      .get(client.id) as { n: number };
    expect(remaining.n).toBe(1);
  });

  it('requires a non-empty reason', () => {
    const entity = store.upsert('team_member', 'X', { email: 'x@x.com', status: 'active' });
    expect(() => store.purge(entity.id, '')).toThrow(EntityStoreError);
    expect(() => store.purge(entity.id, '   ')).toThrow(EntityStoreError);
  });

  it('records the reason and severed-incoming list in the audit log', () => {
    const team = store.upsert('team_member', 'Bethany', {
      email: 'b@x.com',
      status: 'active',
    });
    const client = store.upsert('client', 'Camilla', {
      legal_name: 'Camilla Asher',
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    store.relate(client.id, 'has_therapist', team.id);
    store.purge(team.id, 'test fixture');
    const audit = store.auditFor(team.id);
    expect(audit[0]!.op).toBe('purge');
    expect((audit[0]!.diff as { reason: string }).reason).toBe('test fixture');
    expect((audit[0]!.diff as { severed_incoming: unknown[] }).severed_incoming).toHaveLength(1);
  });
});

describe('EntityStore with validator', () => {
  it('rejects upserts that fail validation', () => {
    store.close();
    rmSync(dbPath, { force: true });
    const validator = {
      validate: (
        kind: string,
        properties: Record<string, unknown>,
      ): { valid: boolean; errors: Array<{ property: string; message: string }> } => {
        if (kind === 'client' && !('legal_name' in properties)) {
          return { valid: false, errors: [{ property: 'legal_name', message: 'is required' }] };
        }
        return { valid: true, errors: [] };
      },
    };
    const validatingStore = new EntityStore({ filePath: dbPath, validator });
    expect(() => validatingStore.upsert('client', 'Anonymous', { status: 'active' })).toThrowError(
      /validation failed/,
    );
    expect(
      validatingStore.upsert('client', 'Ari', { legal_name: 'Ariel Goolsby', status: 'active' }),
    ).toMatchObject({ name: 'Ari' });
    validatingStore.close();
  });
});

describe('EntityStore persistence', () => {
  it('survives reopen of the same file', () => {
    const created = store.upsert('team_member', 'Heather', {
      email: 'h@x.com',
      status: 'active',
    });
    store.close();
    const reopened = new EntityStore({
      filePath: dbPath,
      naturalKeys: {
        team_member: {
          fields: ['email'],
          normalize: (v): string | null => (typeof v === 'string' ? v.trim().toLowerCase() : null),
        },
      },
    });
    const fetched = reopened.get(created.id);
    expect(fetched?.name).toBe('Heather');
    reopened.close();
  });
});
