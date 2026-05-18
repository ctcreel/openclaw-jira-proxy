import { describe, expect, it } from 'vitest';

import { renderEntityModel } from '../../../src/services/entities/entity-model-renderer.service';
import type {
  EntityKindSchema,
  RelationsConfig,
} from '../../../src/services/entities/entity-schema.service';

const SCHEMAS: Record<string, EntityKindSchema> = {
  client: {
    type: 'object',
    description: 'A person receiving therapy services from the practice.',
    required: ['legal_name', 'status'],
    properties: {
      legal_name: { type: 'string', description: 'Full legal name' },
      nickname: { type: 'string', description: 'Preferred name' },
      aliases: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['active', 'former'] },
    },
  },
  team_member: {
    type: 'object',
    description: 'A therapist or staff member.',
    required: ['email', 'status'],
    properties: {
      email: { type: 'string', format: 'email' },
      role: { type: 'string' },
      status: { type: 'string', enum: ['active', 'departed'] },
    },
  },
  location: {
    type: 'object',
    properties: { slug: { type: 'string' }, status: { type: 'string' } },
  },
};

const RELATIONS: RelationsConfig = {
  has_therapist: {
    from: 'client',
    to: 'team_member',
    description: 'assigned therapist',
  },
  seen_at: {
    from: 'client',
    to: 'location',
    description: 'where sessions occur',
    properties: { room: { type: 'string' } },
  },
};

describe('renderEntityModel', () => {
  it('renders the kinds in scope', () => {
    const result = renderEntityModel({
      schemas: SCHEMAS,
      relations: RELATIONS,
      kinds: ['client', 'team_member'],
    });
    expect(result).toContain('### client');
    expect(result).toContain('### team_member');
    expect(result).not.toContain('### location');
  });

  it('marks required properties', () => {
    const result = renderEntityModel({
      schemas: SCHEMAS,
      relations: RELATIONS,
      kinds: ['client'],
    });
    expect(result).toContain('`legal_name` (required): string');
    expect(result).toContain('`nickname`: string');
  });

  it('surfaces descriptions, enum values, and format hints', () => {
    const result = renderEntityModel({
      schemas: SCHEMAS,
      relations: RELATIONS,
      kinds: ['client', 'team_member'],
    });
    expect(result).toContain('Full legal name');
    expect(result).toContain('enum: ["active", "former"]');
    expect(result).toContain('string (email)');
  });

  it('renders array types', () => {
    const result = renderEntityModel({
      schemas: SCHEMAS,
      relations: RELATIONS,
      kinds: ['client'],
    });
    expect(result).toContain('`aliases`: string[]');
  });

  it('only renders relations whose from + to are both in scope', () => {
    const result = renderEntityModel({
      schemas: SCHEMAS,
      relations: RELATIONS,
      kinds: ['client', 'team_member'],
    });
    expect(result).toContain('--has_therapist-->');
    expect(result).not.toContain('--seen_at-->');
  });

  it('renders relation properties', () => {
    const result = renderEntityModel({
      schemas: SCHEMAS,
      relations: RELATIONS,
      kinds: ['client', 'location'],
    });
    expect(result).toContain('--seen_at { room }-->');
  });

  it('handles schemaless kinds without crashing', () => {
    const result = renderEntityModel({
      schemas: {},
      relations: {},
      kinds: ['unknown_kind'],
    });
    expect(result).toContain('### unknown_kind');
    expect(result).toContain('No schema declared');
  });

  it('handles empty kinds list', () => {
    const result = renderEntityModel({
      schemas: SCHEMAS,
      relations: RELATIONS,
      kinds: [],
    });
    expect(result).toContain('No relations in scope');
  });
});
