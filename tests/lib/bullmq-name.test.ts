import { describe, it, expect } from 'vitest';

import { assertBullmqSafeName, BULLMQ_SAFE_NAME } from '../../src/lib/bullmq-name';

describe('assertBullmqSafeName', () => {
  describe('accepts BullMQ-safe names', () => {
    it.each([
      ['webhooks-jira'],
      ['webhooks-github'],
      ['webhooks-tasks-scarlett'],
      ['webhooks-tasks-patch'],
      ['clawndom-reaper'],
      // Single-character names are valid as long as they're alphanumeric.
      ['a'],
      ['0'],
      // Underscores are accepted (some legacy callers use them).
      ['queue_name_with_underscore'],
      // Numerals after the first position are fine.
      ['queue-1'],
    ])('does not throw on %s', (name) => {
      expect(() => assertBullmqSafeName(name)).not.toThrow();
    });
  });

  describe("rejects names containing ':'", () => {
    // The headline regression — BullMQ uses ':' as its Redis key
    // separator and refuses to construct a Queue/Worker with such a
    // name. SPE-1824 (`tasks:scarlett`) and SPE-1999
    // (`clawndom:reaper`) shipped this bug to production.
    it.each([
      ['webhooks:jira'],
      ['tasks:scarlett'],
      ['clawndom:reaper'],
      // Colon anywhere in the string, not just as a separator.
      ['leading:colon'],
      ['trailing:'],
      [':leading'],
      // The ':'-specific message is preferred over the regex message
      // because it names the actual cause loudly.
      ['multiple:colons:here'],
    ])('throws on %s', (name) => {
      expect(() => assertBullmqSafeName(name)).toThrow(
        /BullMQ uses ':' as its Redis key separator/,
      );
    });
  });

  describe('rejects names that are otherwise unsafe', () => {
    it.each([
      // Uppercase letters — BullMQ may technically accept these, but the
      // project convention is lowercase-only for identifier hygiene.
      ['Webhooks-jira'],
      ['UPPERCASE'],
      ['camelCase'],
      // Whitespace and punctuation outside the allowed set.
      ['webhooks jira'],
      ['queue/name'],
      ['queue.name'],
      ['queue@name'],
      // Leading non-alphanumeric character.
      ['-leading-hyphen'],
      ['_leading-underscore'],
      // Empty string.
      [''],
    ])('throws on %s', (name) => {
      expect(() => assertBullmqSafeName(name)).toThrow(/is not safe/);
    });
  });

  it('exports the regex so callers can test names without throwing', () => {
    expect(BULLMQ_SAFE_NAME.test('webhooks-jira')).toBe(true);
    expect(BULLMQ_SAFE_NAME.test('Webhooks-jira')).toBe(false);
    expect(BULLMQ_SAFE_NAME.test('webhooks:jira')).toBe(false);
  });
});
