import { describe, it, expect } from 'vitest';

import {
  toolRefSchema,
  ruleToolsSchema,
  getToolReference,
} from '../../../src/services/tools/config-schemas';

describe('toolRefSchema', () => {
  describe('module.python', () => {
    it('accepts a valid dotted Python reference', () => {
      expect(() =>
        toolRefSchema.parse({ 'module.python': 'agency_tools.slack.post' }),
      ).not.toThrow();
    });

    it('accepts a single-segment Python reference', () => {
      expect(() => toolRefSchema.parse({ 'module.python': 'standalone_tool' })).not.toThrow();
    });

    it('rejects a Python reference containing hyphens', () => {
      expect(() => toolRefSchema.parse({ 'module.python': 'agency_tools.slack-post' })).toThrow(
        /Python tool reference/,
      );
    });

    it('rejects a Python reference with leading dot', () => {
      expect(() => toolRefSchema.parse({ 'module.python': '.foo.bar' })).toThrow();
    });

    it('rejects a Python reference with trailing dot', () => {
      expect(() => toolRefSchema.parse({ 'module.python': 'foo.bar.' })).toThrow();
    });

    it('rejects a Python reference with empty segment', () => {
      expect(() => toolRefSchema.parse({ 'module.python': 'foo..bar' })).toThrow();
    });

    it('rejects a Python reference starting with a digit', () => {
      expect(() => toolRefSchema.parse({ 'module.python': '1foo.bar' })).toThrow();
    });
  });

  describe('shape rejections', () => {
    it('rejects an empty entry', () => {
      expect(() => toolRefSchema.parse({})).toThrow();
    });

    it('rejects an entry with extra keys alongside module.python', () => {
      expect(() =>
        toolRefSchema.parse({
          'module.python': 'agency_tools.slack.post',
          extraField: 'value',
        }),
      ).toThrow();
    });

    it('rejects an entry with module.bash (now removed)', () => {
      // module.bash was removed in the SPE-2078 followups. A typo or stale
      // config must fail loudly rather than silently match nothing.
      expect(() => toolRefSchema.parse({ 'module.bash': 'pkg.tool' })).toThrow();
    });

    it('rejects an entry with module.rust (unknown language)', () => {
      // module.rust is reserved for a future change. Today it must be rejected
      // so a typo doesn't silently match nothing.
      expect(() => toolRefSchema.parse({ 'module.rust': 'pkg.tool' })).toThrow();
    });
  });
});

describe('ruleToolsSchema', () => {
  it('accepts an empty list', () => {
    expect(() => ruleToolsSchema.parse([])).not.toThrow();
  });

  it('accepts a list of python tools', () => {
    expect(() =>
      ruleToolsSchema.parse([
        { 'module.python': 'agency_tools.slack.post' },
        { 'module.python': 'agency_tools.slack.conversations_history' },
      ]),
    ).not.toThrow();
  });

  it('rejects a list containing one invalid entry', () => {
    expect(() =>
      ruleToolsSchema.parse([
        { 'module.python': 'agency_tools.slack.post' },
        { 'module.python': 'agency_tools.slack-post' }, // hyphen → invalid
      ]),
    ).toThrow();
  });
});

describe('getToolReference', () => {
  it('returns the python reference string', () => {
    expect(getToolReference({ 'module.python': 'agency_tools.slack.post' })).toBe(
      'agency_tools.slack.post',
    );
  });
});
