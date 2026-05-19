import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SchemaLoaderError,
  SchemaValidator,
  loadWorkspaceSchemas,
  type EntityKindSchema,
} from '../../../src/services/entities/entity-schema.service';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'clawndom-schemas-'));
  mkdirSync(join(workspace, 'schemas'), { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeSchema(kind: string, schema: EntityKindSchema): void {
  writeFileSync(join(workspace, 'schemas', `${kind}.schema.json`), JSON.stringify(schema));
}

function writeRelations(content: unknown): void {
  writeFileSync(join(workspace, 'relations.json'), JSON.stringify(content));
}

describe('loadWorkspaceSchemas', () => {
  it('loads schemas + relations from the workspace', () => {
    writeSchema('client', {
      type: 'object',
      title: 'client',
      required: ['legal_name', 'status'],
      properties: {
        legal_name: { type: 'string', description: 'Full legal name' },
        status: { type: 'string', enum: ['active', 'former'] },
      },
    });
    writeRelations({
      has_therapist: {
        from: 'client',
        to: 'team_member',
        description: 'Current assigned therapist',
      },
    });
    const result = loadWorkspaceSchemas(workspace);
    expect(result.schemas.client).toBeDefined();
    expect(result.schemas.client!.required).toEqual(['legal_name', 'status']);
    expect(result.relations.has_therapist).toBeDefined();
    expect(result.relations.has_therapist!.from).toBe('client');
  });

  it('derives natural keys from x-natural-keys', () => {
    writeSchema('team_member', {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', format: 'email' },
        name: { type: 'string' },
      },
      'x-natural-keys': ['email'],
    });
    const result = loadWorkspaceSchemas(workspace);
    expect(result.naturalKeys.team_member).toBeDefined();
    expect(result.naturalKeys.team_member!.fields).toEqual(['email']);
    const normalize = result.naturalKeys.team_member!.normalize!;
    expect(normalize('  Heather@Talk.info  ')).toBe('heather@talk.info');
    expect(normalize('')).toBeNull();
    expect(normalize(42)).toBeNull();
  });

  it('indexes identity properties by format', () => {
    writeSchema('team_member', {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        slack_user_id: { type: 'string' },
      },
    });
    writeSchema('contact', {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        phone: { type: 'string', format: 'phone' },
      },
    });
    const result = loadWorkspaceSchemas(workspace);
    expect(result.identityProperties.byFormat.email).toEqual(
      expect.arrayContaining([
        { kind: 'team_member', property: 'email' },
        { kind: 'contact', property: 'email' },
      ]),
    );
    expect(result.identityProperties.byFormat.phone).toEqual([
      { kind: 'contact', property: 'phone' },
    ]);
    expect(result.identityProperties.byPropertyName.slack_user_id).toEqual([
      { kind: 'team_member', property: 'slack_user_id' },
    ]);
  });

  it('handles a workspace with no schemas (empty config)', () => {
    const result = loadWorkspaceSchemas(workspace);
    expect(result.schemas).toEqual({});
    expect(result.relations).toEqual({});
    expect(result.naturalKeys).toEqual({});
  });

  it('throws WORKSPACE_NOT_FOUND for missing path', () => {
    expect(() => loadWorkspaceSchemas('/nonexistent/path/xyz')).toThrow(SchemaLoaderError);
  });

  it('throws SCHEMA_PARSE_ERROR on malformed JSON', () => {
    writeFileSync(join(workspace, 'schemas', 'broken.schema.json'), '{ not json');
    expect(() => loadWorkspaceSchemas(workspace)).toThrow(SchemaLoaderError);
  });

  it('throws INVALID_SCHEMA when type is not object', () => {
    writeFileSync(
      join(workspace, 'schemas', 'weird.schema.json'),
      JSON.stringify({ type: 'string' }),
    );
    expect(() => loadWorkspaceSchemas(workspace)).toThrow(SchemaLoaderError);
  });
});

describe('SchemaValidator', () => {
  it('accepts a valid record', () => {
    const validator = new SchemaValidator({
      client: {
        type: 'object',
        required: ['legal_name', 'status'],
        properties: {
          legal_name: { type: 'string' },
          status: { type: 'string', enum: ['active', 'former'] },
        },
      },
    });
    const result = validator.validate('client', {
      legal_name: 'Ari Goolsby',
      status: 'active',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects missing required property', () => {
    const validator = new SchemaValidator({
      client: {
        type: 'object',
        required: ['legal_name', 'date_of_birth', 'status'],
        properties: {
          legal_name: { type: 'string' },
          date_of_birth: { type: 'string', format: 'date' },
          status: { type: 'string' },
        },
      },
    });
    const result = validator.validate('client', {
      date_of_birth: '2018-04-12',
      status: 'active',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toMatch(/legal_name/);
  });

  it('enforces ISO-8601 date format', () => {
    const validator = new SchemaValidator({
      client: {
        type: 'object',
        required: ['started_at'],
        properties: {
          started_at: { type: 'string', format: 'date' },
        },
      },
    });
    const badResult = validator.validate('client', { started_at: '2/19/2025' });
    expect(badResult.valid).toBe(false);
    const goodResult = validator.validate('client', { started_at: '2025-02-19' });
    expect(goodResult.valid).toBe(true);
  });

  it('enforces email format', () => {
    const validator = new SchemaValidator({
      team_member: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
        },
      },
    });
    expect(validator.validate('team_member', { email: 'not-an-email' }).valid).toBe(false);
    expect(validator.validate('team_member', { email: 'h@talk.info' }).valid).toBe(true);
  });

  it('schemaless fallback: unknown kinds always validate', () => {
    const validator = new SchemaValidator({});
    const result = validator.validate('vendor', { whatever: 'value' });
    expect(result.valid).toBe(true);
  });

  it('enforces enum values', () => {
    const validator = new SchemaValidator({
      client: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['active', 'former', 'waitlist', 'discharged'] },
        },
      },
    });
    expect(validator.validate('client', { status: 'maybe' }).valid).toBe(false);
    expect(validator.validate('client', { status: 'former' }).valid).toBe(true);
  });
});
