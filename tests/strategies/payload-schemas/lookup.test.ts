import { describe, expect, it } from 'vitest';

import { resolveArrayItem, resolvePath } from '../../../src/strategies/payload-schemas';
import type { JsonSchema } from '../../../src/strategies/payload-schemas/types';

describe('resolvePath', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      issue: {
        type: 'object',
        properties: {
          fields: {
            type: 'object',
            properties: {
              status: {
                type: 'object',
                properties: { name: { type: 'string' } },
                additionalProperties: true,
              },
            },
          },
        },
      },
      openLeaf: {
        type: 'object',
        additionalProperties: true,
      },
    },
  };

  it('resolves a fully-typed dotted path', () => {
    const result = resolvePath(schema, 'issue.fields.status.name');
    expect(result.exists).toBe(true);
    expect(result.schema?.type).toBe('string');
  });

  it('reports the path as missing when an intermediate segment is unknown', () => {
    expect(resolvePath(schema, 'issue.field.status.name').exists).toBe(false);
  });

  it('reports the path as missing when the leaf is unknown', () => {
    expect(resolvePath(schema, 'issue.fields.priority.name').exists).toBe(false);
  });

  it('accepts deeper paths under additionalProperties: true subtrees', () => {
    const result = resolvePath(schema, 'openLeaf.whatever.deeply.nested');
    expect(result.exists).toBe(true);
    expect(result.schema).toBeUndefined();
  });

  it('returns the root schema for an empty path', () => {
    expect(resolvePath(schema, '').exists).toBe(true);
  });
});

describe('resolveArrayItem', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      changelog: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                toString: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  };

  it('returns the item schema when the path resolves to a typed array', () => {
    const result = resolveArrayItem(schema, 'changelog.items');
    expect(result.exists).toBe(true);
    expect(result.schema?.properties?.['field']?.type).toBe('string');
  });

  it('reports missing when the path itself does not resolve', () => {
    expect(resolveArrayItem(schema, 'changelog.entries').exists).toBe(false);
  });
});
