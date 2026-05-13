import { describe, expect, it } from 'vitest';

import { formatAsKebab, resolveRuleId } from '../../src/services/rule-id';

describe('resolveRuleId', () => {
  it('returns the explicit id when set', () => {
    expect(resolveRuleId({ id: 'triage', name: 'Different Name' }, 0)).toBe('triage');
  });

  it('falls back to a kebab-slug of name when id is absent', () => {
    expect(resolveRuleId({ name: 'Triage Heather Inbox' }, 0)).toBe('triage-heather-inbox');
  });

  it('falls back to positional id when neither id nor name is set', () => {
    expect(resolveRuleId({}, 3)).toBe('rule-3');
  });

  it('drops empty slugs to the positional fallback (e.g. name is pure punctuation)', () => {
    expect(resolveRuleId({ name: '!!' }, 2)).toBe('rule-2');
  });
});

describe('formatAsKebab', () => {
  it('lowercases and replaces non-alphanumeric runs with single hyphens', () => {
    expect(formatAsKebab('Hello World!')).toBe('hello-world');
  });

  it('strips leading/trailing hyphens', () => {
    expect(formatAsKebab('  spaced  ')).toBe('spaced');
  });

  it('strips leading non-letters so the slug always starts with a letter', () => {
    expect(formatAsKebab('123-go')).toBe('go');
  });

  it('collapses repeated separators', () => {
    expect(formatAsKebab('foo___bar---baz')).toBe('foo-bar-baz');
  });
});
