import { describe, it, expect } from 'vitest';

import {
  parseFrontmatter,
  templateHasToolsPlaceholder,
} from '../../../src/lib/template/frontmatter';

describe('parseFrontmatter', () => {
  it('returns empty manifest for templates without an opening fence', () => {
    const result = parseFrontmatter('# Just a heading\n\nbody');
    expect(result.frontmatter.tools).toEqual([]);
    expect(result.body).toBe('# Just a heading\n\nbody');
    expect(result.rawFrontmatter).toBe('');
  });

  it('parses a valid tools manifest', () => {
    const template = [
      '---',
      'tools:',
      '  - module: agency_tools.slack.post',
      '    requires_env:',
      '      - slack_patch_bot',
      '  - module: agency_tools.jira.search',
      '---',
      'body content',
    ].join('\n');

    const result = parseFrontmatter(template);
    expect(result.frontmatter.tools).toEqual([
      {
        module: 'agency_tools.slack.post',
        requires_env: ['slack_patch_bot'],
      },
      {
        module: 'agency_tools.jira.search',
        requires_env: [],
      },
    ]);
    expect(result.body).toBe('body content');
    expect(result.rawFrontmatter).toContain('agency_tools.slack.post');
  });

  it('treats an empty frontmatter document as zero tools', () => {
    const template = ['---', '---', 'body'].join('\n');
    const result = parseFrontmatter(template);
    expect(result.frontmatter.tools).toEqual([]);
    expect(result.body).toBe('body');
  });

  it('treats an empty tools list as zero tools', () => {
    const template = ['---', 'tools: []', '---', 'body'].join('\n');
    expect(parseFrontmatter(template).frontmatter.tools).toEqual([]);
  });

  it('throws when YAML is malformed', () => {
    const template = ['---', 'tools: [unterminated', '---', 'body'].join('\n');
    expect(() => parseFrontmatter(template)).toThrow(/not valid YAML/);
  });

  it('throws when an unknown top-level key is declared (.strict() schema)', () => {
    const template = ['---', 'tools: []', 'extra_field: oops', '---', 'body'].join('\n');
    expect(() => parseFrontmatter(template)).toThrow();
  });

  it('throws when a tool entry has an unknown key (.strict() schema)', () => {
    const template = [
      '---',
      'tools:',
      '  - module: agency_tools.slack.post',
      '    kind: py',
      '---',
      'body',
    ].join('\n');
    expect(() => parseFrontmatter(template)).toThrow();
  });

  it('throws when the opening fence is never closed', () => {
    const template = ['---', 'tools: []', 'no closing fence here'].join('\n');
    expect(() => parseFrontmatter(template)).toThrow(/never closes it/);
  });

  it('throws when module is missing on a tool entry', () => {
    const template = ['---', 'tools:', '  - requires_env: [some_key]', '---', 'body'].join('\n');
    expect(() => parseFrontmatter(template)).toThrow();
  });
});

describe('templateHasToolsPlaceholder', () => {
  it('returns true when {{tools}} appears anywhere in the body', () => {
    expect(templateHasToolsPlaceholder('top\n{{tools}}\nbottom')).toBe(true);
  });

  it('returns false when only doc/shared placeholders are present', () => {
    expect(templateHasToolsPlaceholder('{{doc:foo.md}} {{shared:bar.md}}')).toBe(false);
  });

  it('returns false when the body has no placeholder at all', () => {
    expect(templateHasToolsPlaceholder('plain markdown body')).toBe(false);
  });
});
