import { describe, it, expect } from 'vitest';

import {
  conditionSchema,
  evaluateCondition,
  type Condition,
} from '../../../src/strategies/routing/condition';

describe('conditionSchema', () => {
  it('accepts a valid equals leaf', () => {
    const parsed = conditionSchema.parse({ equals: { field: 'a', value: 'x' } });
    expect(parsed).toEqual({ equals: { field: 'a', value: 'x' } });
  });

  it('accepts a valid in leaf', () => {
    const parsed = conditionSchema.parse({ in: { field: 'a', values: ['x', 'y'] } });
    expect(parsed).toEqual({ in: { field: 'a', values: ['x', 'y'] } });
  });

  it('accepts a valid matches leaf with flags', () => {
    const parsed = conditionSchema.parse({
      matches: { field: 'a', pattern: '^foo', flags: 'i' },
    });
    expect(parsed).toEqual({ matches: { field: 'a', pattern: '^foo', flags: 'i' } });
  });

  it('accepts a valid exists leaf', () => {
    const parsed = conditionSchema.parse({ exists: { field: 'a' } });
    expect(parsed).toEqual({ exists: { field: 'a' } });
  });

  it('accepts nested composites', () => {
    const parsed = conditionSchema.parse({
      all_of: [
        { equals: { field: 'type', value: 'Bug' } },
        { any_of: [{ equals: { field: 'status', value: 'Open' } }] },
      ],
    });
    expect(parsed).toEqual({
      all_of: [
        { equals: { field: 'type', value: 'Bug' } },
        { any_of: [{ equals: { field: 'status', value: 'Open' } }] },
      ],
    });
  });

  it('rejects an invalid regex pattern at parse time', () => {
    expect(() => conditionSchema.parse({ matches: { field: 'a', pattern: '[' } })).toThrow();
  });

  it('rejects invalid regex flags', () => {
    expect(() =>
      conditionSchema.parse({ matches: { field: 'a', pattern: '.*', flags: 'zz' } }),
    ).toThrow();
  });

  it('rejects an empty in values list', () => {
    expect(() => conditionSchema.parse({ in: { field: 'a', values: [] } })).toThrow();
  });

  it('rejects an empty field string', () => {
    expect(() => conditionSchema.parse({ equals: { field: '', value: 'x' } })).toThrow();
  });

  it('rejects unknown operator names', () => {
    expect(() => conditionSchema.parse({ not_an_op: { field: 'a' } })).toThrow();
  });
});

describe('evaluateCondition — equals', () => {
  it('matches a scalar field equal to the target value', () => {
    const cond: Condition = { equals: { field: 'type', value: 'Bug' } };
    expect(evaluateCondition({ type: 'Bug' }, cond)).toBe(true);
  });

  it('does not match a differing scalar field', () => {
    const cond: Condition = { equals: { field: 'type', value: 'Bug' } };
    expect(evaluateCondition({ type: 'Story' }, cond)).toBe(false);
  });

  it('matches any array element equal to the target value', () => {
    const cond: Condition = { equals: { field: 'labels', value: 'infra' } };
    expect(evaluateCondition({ labels: ['urgent', 'infra'] }, cond)).toBe(true);
  });

  it('resolves dot-notation field paths', () => {
    const cond: Condition = {
      equals: { field: 'issue.fields.assignee.displayName', value: 'Patches' },
    };
    expect(
      evaluateCondition({ issue: { fields: { assignee: { displayName: 'Patches' } } } }, cond),
    ).toBe(true);
  });

  it('returns false when the field path is missing', () => {
    const cond: Condition = { equals: { field: 'missing.path', value: 'x' } };
    expect(evaluateCondition({}, cond)).toBe(false);
  });

  it('returns false when the field is explicitly null', () => {
    const cond: Condition = { equals: { field: 'type', value: 'Bug' } };
    expect(evaluateCondition({ type: null }, cond)).toBe(false);
  });

  it('coerces non-string scalars to strings before comparing', () => {
    const cond: Condition = { equals: { field: 'count', value: '42' } };
    expect(evaluateCondition({ count: 42 }, cond)).toBe(true);
  });
});

describe('evaluateCondition — in', () => {
  it('matches when the scalar value is in the target list', () => {
    const cond: Condition = { in: { field: 'status', values: ['Plan', 'Planning'] } };
    expect(evaluateCondition({ status: 'Plan' }, cond)).toBe(true);
  });

  it('does not match when the scalar value is not in the list', () => {
    const cond: Condition = { in: { field: 'status', values: ['Plan', 'Planning'] } };
    expect(evaluateCondition({ status: 'Done' }, cond)).toBe(false);
  });

  it('matches any array element in the target list', () => {
    const cond: Condition = { in: { field: 'labels', values: ['infra', 'ops'] } };
    expect(evaluateCondition({ labels: ['urgent', 'ops'] }, cond)).toBe(true);
  });

  it('returns false when the field is missing', () => {
    const cond: Condition = { in: { field: 'missing', values: ['x'] } };
    expect(evaluateCondition({}, cond)).toBe(false);
  });

  it('returns false when the field is null', () => {
    const cond: Condition = { in: { field: 'status', values: ['x'] } };
    expect(evaluateCondition({ status: null }, cond)).toBe(false);
  });
});

describe('evaluateCondition — matches', () => {
  it('matches a scalar value by regex', () => {
    const cond: Condition = { matches: { field: 'event', pattern: '^comment_' } };
    expect(evaluateCondition({ event: 'comment_added' }, cond)).toBe(true);
  });

  it('honors flags', () => {
    const cond: Condition = { matches: { field: 'event', pattern: '^COMMENT_', flags: 'i' } };
    expect(evaluateCondition({ event: 'comment_added' }, cond)).toBe(true);
  });

  it('matches any array element', () => {
    const cond: Condition = { matches: { field: 'labels', pattern: 'infra' } };
    expect(evaluateCondition({ labels: ['security', 'infra-backend'] }, cond)).toBe(true);
  });

  it('returns false when the field is missing', () => {
    const cond: Condition = { matches: { field: 'missing', pattern: '.*' } };
    expect(evaluateCondition({}, cond)).toBe(false);
  });

  it('returns false when the field is null', () => {
    const cond: Condition = { matches: { field: 'event', pattern: '.*' } };
    expect(evaluateCondition({ event: null }, cond)).toBe(false);
  });
});

describe('evaluateCondition — exists', () => {
  it('returns true when the field is present with a scalar value', () => {
    const cond: Condition = { exists: { field: 'type' } };
    expect(evaluateCondition({ type: 'Bug' }, cond)).toBe(true);
  });

  it('returns true for an empty-string value (present, not null, not undefined)', () => {
    const cond: Condition = { exists: { field: 'type' } };
    expect(evaluateCondition({ type: '' }, cond)).toBe(true);
  });

  it('returns true for an empty array (present, not null, not undefined)', () => {
    const cond: Condition = { exists: { field: 'labels' } };
    expect(evaluateCondition({ labels: [] }, cond)).toBe(true);
  });

  it('returns false when the field is missing', () => {
    const cond: Condition = { exists: { field: 'missing' } };
    expect(evaluateCondition({}, cond)).toBe(false);
  });

  it('returns false when the field is null', () => {
    const cond: Condition = { exists: { field: 'type' } };
    expect(evaluateCondition({ type: null }, cond)).toBe(false);
  });
});

describe('evaluateCondition — all_of (AND)', () => {
  it('returns true when every child matches', () => {
    const cond: Condition = {
      all_of: [
        { equals: { field: 'type', value: 'Bug' } },
        { equals: { field: 'status', value: 'Open' } },
      ],
    };
    expect(evaluateCondition({ type: 'Bug', status: 'Open' }, cond)).toBe(true);
  });

  it('returns false when any child does not match', () => {
    const cond: Condition = {
      all_of: [
        { equals: { field: 'type', value: 'Bug' } },
        { equals: { field: 'status', value: 'Open' } },
      ],
    };
    expect(evaluateCondition({ type: 'Bug', status: 'Closed' }, cond)).toBe(false);
  });

  it('returns true for an empty children list (vacuous truth)', () => {
    const cond: Condition = { all_of: [] };
    expect(evaluateCondition({}, cond)).toBe(true);
  });
});

describe('evaluateCondition — any_of (OR)', () => {
  it('returns true when any child matches', () => {
    const cond: Condition = {
      any_of: [
        { equals: { field: 'type', value: 'Bug' } },
        { equals: { field: 'type', value: 'Story' } },
      ],
    };
    expect(evaluateCondition({ type: 'Story' }, cond)).toBe(true);
  });

  it('returns false when no child matches', () => {
    const cond: Condition = {
      any_of: [
        { equals: { field: 'type', value: 'Bug' } },
        { equals: { field: 'type', value: 'Story' } },
      ],
    };
    expect(evaluateCondition({ type: 'Epic' }, cond)).toBe(false);
  });

  it('returns false for an empty children list', () => {
    const cond: Condition = { any_of: [] };
    expect(evaluateCondition({}, cond)).toBe(false);
  });
});

describe('evaluateCondition — not', () => {
  it('negates a true child to false', () => {
    const cond: Condition = { not: { equals: { field: 'type', value: 'Bug' } } };
    expect(evaluateCondition({ type: 'Bug' }, cond)).toBe(false);
  });

  it('negates a false child to true', () => {
    const cond: Condition = { not: { equals: { field: 'type', value: 'Bug' } } };
    expect(evaluateCondition({ type: 'Story' }, cond)).toBe(true);
  });

  it('returns true when negating a leaf over a missing field', () => {
    const cond: Condition = { not: { equals: { field: 'missing', value: 'x' } } };
    expect(evaluateCondition({}, cond)).toBe(true);
  });
});

describe('evaluateCondition — nesting', () => {
  it('evaluates deep composite nesting (all_of of any_of of leaves)', () => {
    const cond: Condition = {
      all_of: [
        { equals: { field: 'type', value: 'Bug' } },
        {
          any_of: [
            { equals: { field: 'status', value: 'Plan' } },
            { equals: { field: 'status', value: 'Planning' } },
          ],
        },
      ],
    };
    expect(evaluateCondition({ type: 'Bug', status: 'Planning' }, cond)).toBe(true);
    expect(evaluateCondition({ type: 'Bug', status: 'Done' }, cond)).toBe(false);
    expect(evaluateCondition({ type: 'Story', status: 'Plan' }, cond)).toBe(false);
  });

  it('evaluates not wrapping a composite', () => {
    const cond: Condition = {
      not: {
        any_of: [
          { equals: { field: 'status', value: 'Closed' } },
          { equals: { field: 'status', value: 'Abandoned' } },
        ],
      },
    };
    expect(evaluateCondition({ status: 'Open' }, cond)).toBe(true);
    expect(evaluateCondition({ status: 'Closed' }, cond)).toBe(false);
  });
});
