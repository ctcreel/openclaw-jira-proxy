import { describe, it, expect } from 'vitest';

import { resolveFieldPath } from '../../../src/strategies/routing/field-path';

describe('resolveFieldPath', () => {
  it('should resolve a simple top-level field', () => {
    expect(resolveFieldPath({ name: 'Patch' }, 'name')).toBe('Patch');
  });

  it('should resolve a nested field via dot notation', () => {
    const payload = { issue: { fields: { assignee: { displayName: 'Patches' } } } };
    expect(resolveFieldPath(payload, 'issue.fields.assignee.displayName')).toBe('Patches');
  });

  it('should return an array when the field is an array', () => {
    const payload = { issue: { fields: { labels: ['infra', 'urgent'] } } };
    expect(resolveFieldPath(payload, 'issue.fields.labels')).toEqual(['infra', 'urgent']);
  });

  it('should return undefined for a missing path', () => {
    expect(resolveFieldPath({ a: { b: 'c' } }, 'a.x.y')).toBeUndefined();
  });

  it('should return undefined when payload is null', () => {
    expect(resolveFieldPath(null, 'a.b')).toBeUndefined();
  });

  it('should return undefined when payload is a primitive', () => {
    expect(resolveFieldPath('hello', 'length')).toBeUndefined();
  });

  it('should resolve a numeric value', () => {
    expect(resolveFieldPath({ count: 42 }, 'count')).toBe(42);
  });

  it('should resolve a boolean value', () => {
    expect(resolveFieldPath({ active: true }, 'active')).toBe(true);
  });
});
