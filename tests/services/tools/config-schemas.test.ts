import { describe, it, expect } from 'vitest';

import {
  toolRefSchema,
  ruleToolsSchema,
  getToolKind,
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

  describe('module.bash', () => {
    it('accepts a valid dotted bash reference', () => {
      expect(() =>
        toolRefSchema.parse({ 'module.bash': 'winston_agent.jira.generate-patches-token' }),
      ).not.toThrow();
    });

    it('accepts hyphens in bash reference segments', () => {
      expect(() => toolRefSchema.parse({ 'module.bash': 'pkg.sub-dir.tool-name' })).not.toThrow();
    });

    it('accepts underscores in bash reference segments', () => {
      expect(() => toolRefSchema.parse({ 'module.bash': 'winston_agent.tool_name' })).not.toThrow();
    });

    it('rejects a bash reference with leading hyphen on a segment', () => {
      expect(() => toolRefSchema.parse({ 'module.bash': 'pkg.-leading-hyphen' })).toThrow();
    });
  });

  describe('mutual exclusion', () => {
    it('rejects an entry containing both module.python and module.bash', () => {
      expect(() =>
        toolRefSchema.parse({
          'module.python': 'agency_tools.slack.post',
          'module.bash': 'agency_tools.slack.post',
        }),
      ).toThrow();
    });

    it('rejects an entry containing neither key', () => {
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

  it('accepts a mixed list of python and bash tools', () => {
    expect(() =>
      ruleToolsSchema.parse([
        { 'module.python': 'agency_tools.slack.post' },
        { 'module.python': 'agency_tools.slack.conversations' },
        { 'module.bash': 'winston_agent.jira.generate-patches-token' },
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

describe('getToolKind', () => {
  it('returns python for a module.python entry', () => {
    expect(getToolKind({ 'module.python': 'foo.bar' })).toBe('python');
  });

  it('returns bash for a module.bash entry', () => {
    expect(getToolKind({ 'module.bash': 'foo.bar' })).toBe('bash');
  });
});

describe('getToolReference', () => {
  it('returns the python reference string', () => {
    expect(getToolReference({ 'module.python': 'agency_tools.slack.post' })).toBe(
      'agency_tools.slack.post',
    );
  });

  it('returns the bash reference string', () => {
    expect(getToolReference({ 'module.bash': 'winston_agent.tool' })).toBe('winston_agent.tool');
  });
});
