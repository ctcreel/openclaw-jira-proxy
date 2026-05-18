import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EntityResolver } from '../../../src/services/entities/entity-resolver.service';
import {
  type IdentityPropertyIndex,
  type EntityKindSchema,
  SchemaValidator,
} from '../../../src/services/entities/entity-schema.service';
import { EntityStore } from '../../../src/services/entities/entity-store.service';
import { isStranger, isResolved } from '../../../src/types/actor';

let tempDir: string;
let store: EntityStore;
let resolver: EntityResolver;

const schemas: Record<string, EntityKindSchema> = {
  team_member: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      slack_user_id: { type: 'string' },
      role: { type: 'string' },
      status: { type: 'string' },
    },
    'x-natural-keys': ['email'],
  },
  contact: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      status: { type: 'string' },
    },
    'x-natural-keys': ['email'],
  },
};

const identityProperties: IdentityPropertyIndex = {
  byFormat: {
    email: [
      { kind: 'team_member', property: 'email' },
      { kind: 'contact', property: 'email' },
    ],
  },
  byPropertyName: {
    slack_user_id: [{ kind: 'team_member', property: 'slack_user_id' }],
  },
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clawndom-resolver-'));
  store = new EntityStore({
    filePath: join(tempDir, 'entities.db'),
    naturalKeys: {
      team_member: {
        fields: ['email'],
        normalize: (v): string | null => (typeof v === 'string' ? v.trim().toLowerCase() : null),
      },
      contact: {
        fields: ['email'],
        normalize: (v): string | null => (typeof v === 'string' ? v.trim().toLowerCase() : null),
      },
    },
    validator: new SchemaValidator(schemas),
  });
  resolver = new EntityResolver({ store, identityProperties });
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('EntityResolver', () => {
  it('resolves by email to a team_member', () => {
    store.upsert(
      'team_member',
      'Heather Hamilton',
      {
        email: 'heather@talkatlanta.info',
        slack_user_id: 'U_HEATHER',
        role: 'Senior SLP',
        status: 'active',
      },
      { id: 't_heather' },
    );
    const actor = resolver.resolve({
      identityHints: { email: 'heather@talkatlanta.info' },
    });
    expect(isResolved(actor)).toBe(true);
    expect(actor.kind).toBe('team_member');
    expect(actor.id).toBe('t_heather');
    expect(actor.name).toBe('Heather Hamilton');
    expect(actor.role).toBe('Senior SLP');
  });

  it('case-insensitive email matching', () => {
    store.upsert(
      'team_member',
      'Heather',
      { email: 'heather@talkatlanta.info', status: 'active' },
      { id: 't_heather' },
    );
    const actor = resolver.resolve({
      identityHints: { email: 'HEATHER@TalkAtlanta.info' },
    });
    expect(actor.id).toBe('t_heather');
  });

  it('resolves by slack_user_id when present, ignoring email', () => {
    store.upsert(
      'team_member',
      'Alisha',
      {
        email: 'alisha@talkatlanta.info',
        slack_user_id: 'U_ALISHA',
        status: 'active',
      },
      { id: 't_alisha' },
    );
    store.upsert('contact', 'Wrong Person', {
      email: 'parent@example.com',
      status: 'active',
    });
    const actor = resolver.resolve({
      identityHints: {
        slack_user_id: 'U_ALISHA',
        email: 'parent@example.com',
      },
    });
    expect(actor.kind).toBe('team_member');
    expect(actor.id).toBe('t_alisha');
  });

  it('resolves contact when only the contact kind has the email', () => {
    store.upsert('contact', 'Sarah Smith', {
      email: 'sarah@gmail.com',
      status: 'active',
    });
    const actor = resolver.resolve({
      identityHints: { email: 'sarah@gmail.com' },
    });
    expect(actor.kind).toBe('contact');
  });

  it('falls back to stranger when no entity matches', () => {
    const actor = resolver.resolve({
      identityHints: { email: 'unknown@elsewhere.com' },
    });
    expect(isStranger(actor)).toBe(true);
    if (isStranger(actor)) {
      expect(actor.id).toBeNull();
      expect(actor.email).toBe('unknown@elsewhere.com');
    }
  });

  it('falls back to stranger when no hints provided', () => {
    const actor = resolver.resolve({});
    expect(isStranger(actor)).toBe(true);
    if (isStranger(actor)) {
      expect(actor.email).toBeNull();
    }
  });

  it('honors oidc_email as an alias for email', () => {
    store.upsert(
      'team_member',
      'Heather',
      { email: 'heather@talkatlanta.info', status: 'active' },
      { id: 't_heather' },
    );
    const actor = resolver.resolve({
      identityHints: { oidc_email: 'heather@talkatlanta.info' },
    });
    expect(actor.id).toBe('t_heather');
  });

  it('priority order: slack hint short-circuits before email is even attempted', () => {
    // Sarah (contact) has the same email as Alisha (team_member)
    store.upsert(
      'team_member',
      'Alisha',
      {
        email: 'shared@example.com',
        slack_user_id: 'U_ALISHA',
        status: 'active',
      },
      { id: 't_alisha' },
    );
    const actor = resolver.resolve({
      identityHints: {
        slack_user_id: 'U_ALISHA',
        email: 'shared@example.com',
      },
    });
    expect(actor.kind).toBe('team_member');
    expect(actor.id).toBe('t_alisha');
  });

  it('actor carries the entity properties (no relation walking)', () => {
    store.upsert(
      'team_member',
      'Heather',
      {
        email: 'heather@talkatlanta.info',
        role: 'Senior SLP',
        employment_type: 'Employee',
        status: 'active',
      },
      { id: 't_heather' },
    );
    const actor = resolver.resolve({
      identityHints: { email: 'heather@talkatlanta.info' },
    });
    expect(actor.role).toBe('Senior SLP');
    expect(actor.employment_type).toBe('Employee');
    expect(actor.status).toBe('active');
    // No relation-walking — should NOT have client_ids or similar
    expect((actor as Record<string, unknown>).client_ids).toBeUndefined();
  });
});
