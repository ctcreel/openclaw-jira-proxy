import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { renderTemplate } from '../../../src/lib/template/template-engine';

const BASE_DIR = '/agents/patch';

describe('renderTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders {{ payload }} as full JSON string in the body', async () => {
    const payload = { issue: { key: 'SPE-123' } };
    const result = await renderTemplate('{{ payload }}', payload, BASE_DIR);
    expect(result.body).toBe(JSON.stringify(payload, null, 2));
    expect(result.systemPrompt).toBe('');
  });

  it('resolves top-level payload keys via Nunjucks', async () => {
    const payload = { issue: { key: 'SPE-456' } };
    const result = await renderTemplate('{{ issue.key }}', payload, BASE_DIR);
    expect(result.body).toBe('SPE-456');
  });

  it('inlines file contents for relative {{doc:...}} tags resolved under baseDir', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('# Instructions\nDo the thing.');

    const result = await renderTemplate('{{doc:docs/jira-policy.md}}', { foo: 'bar' }, BASE_DIR);

    expect(readFile).toHaveBeenCalledWith('/agents/patch/docs/jira-policy.md', 'utf-8');
    expect(result.body).toBe('# Instructions\nDo the thing.');
    expect(result.systemPrompt).toBe('');
  });

  it('propagates read errors instead of masking them with a fallback', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

    await expect(renderTemplate('{{doc:missing/file.md}}', {}, BASE_DIR)).rejects.toThrow('ENOENT');
  });

  it('renders missing field as empty string', async () => {
    const result = await renderTemplate('value={{ nonexistent }}', { foo: 'bar' }, BASE_DIR);
    expect(result.body).toBe('value=');
  });

  it('handles both doc tags and Nunjucks variables in the same template', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('file content here');

    const result = await renderTemplate(
      'Key: {{ issue.key }}\nDoc: {{doc:docs/policy.md}}',
      { issue: { key: 'SPE-789' } },
      BASE_DIR,
    );

    expect(result.body).toBe('Key: SPE-789\nDoc: file content here');
  });

  it('handles multiple doc tags', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('first file').mockResolvedValueOnce('second file');

    const result = await renderTemplate(
      '{{doc:policies/a.md}} and {{doc:policies/b.md}}',
      {},
      BASE_DIR,
    );

    expect(result.body).toBe('first file and second file');
  });

  it('resolves {{shared:...}} from the sibling "shared" directory', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('# Engineering Pipeline\nShared content.');

    const result = await renderTemplate('{{shared:sc0red-engineering-pipeline.md}}', {}, BASE_DIR);

    expect(readFile).toHaveBeenCalledWith('/agents/shared/sc0red-engineering-pipeline.md', 'utf-8');
    expect(result.body).toBe('# Engineering Pipeline\nShared content.');
  });

  it('rejects {{shared:...}} paths that escape the shared root', async () => {
    await expect(renderTemplate('{{shared:../patch/docs/SOUL.md}}', {}, BASE_DIR)).rejects.toThrow(
      /escapes shared root/,
    );
  });

  it('interleaves {{doc:...}} and {{shared:...}} in the same template', async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce('agent-only body')
      .mockResolvedValueOnce('shared body');

    const result = await renderTemplate(
      '{{doc:docs/SOUL.md}} then {{shared:anti-patterns.md}}',
      {},
      BASE_DIR,
    );

    expect(result.body).toBe('agent-only body then shared body');
  });

  describe('{{system-doc:…}} / {{system-shared:…}} extraction', () => {
    it('extracts {{system-doc:…}} content into systemPrompt and removes from body', async () => {
      vi.mocked(readFile).mockResolvedValueOnce('You are Patch. Senior engineer.');

      const result = await renderTemplate(
        'Body before {{system-doc:docs/IDENTITY.md}} body after',
        {},
        BASE_DIR,
      );

      expect(readFile).toHaveBeenCalledWith('/agents/patch/docs/IDENTITY.md', 'utf-8');
      expect(result.systemPrompt).toBe('You are Patch. Senior engineer.');
      expect(result.body).toBe('Body before  body after');
    });

    it('extracts {{system-shared:…}} content into systemPrompt and removes from body', async () => {
      vi.mocked(readFile).mockResolvedValueOnce('# Anti-patterns\nDo not do X.');

      const result = await renderTemplate(
        '{{system-shared:docs/anti-patterns.md}}\n\nNow the body.',
        {},
        BASE_DIR,
      );

      expect(readFile).toHaveBeenCalledWith('/agents/shared/docs/anti-patterns.md', 'utf-8');
      expect(result.systemPrompt).toBe('# Anti-patterns\nDo not do X.');
      expect(result.body.trim()).toBe('Now the body.');
    });

    it('concatenates multiple system tags in document order with double-newline separator', async () => {
      vi.mocked(readFile)
        .mockResolvedValueOnce('FIRST identity content')
        .mockResolvedValueOnce('SECOND shared anti-patterns')
        .mockResolvedValueOnce('THIRD soul content');

      const result = await renderTemplate(
        '{{system-doc:docs/IDENTITY.md}}\n{{system-shared:docs/anti-patterns.md}}\n{{system-doc:docs/SOUL.md}}\n\nbody',
        {},
        BASE_DIR,
      );

      expect(result.systemPrompt).toBe(
        'FIRST identity content\n\nSECOND shared anti-patterns\n\nTHIRD soul content',
      );
      expect(result.body.trim()).toBe('body');
    });

    it('renders Nunjucks variables inside the extracted system content', async () => {
      vi.mocked(readFile).mockResolvedValueOnce('You are {{ agent.name }}.');

      const result = await renderTemplate(
        '{{system-doc:docs/IDENTITY.md}}',
        { agent: { name: 'Patch' } },
        BASE_DIR,
      );

      expect(result.systemPrompt).toBe('You are Patch.');
    });

    it('returns empty systemPrompt when the template has no system tags', async () => {
      const result = await renderTemplate('plain template, no system tags', {}, BASE_DIR);
      expect(result.systemPrompt).toBe('');
      expect(result.body).toBe('plain template, no system tags');
    });

    it('coexists with body-level {{doc:…}} / {{shared:…}} tags in the same template', async () => {
      // Mock order matches read order: extractSystemTags reads ALL system
      // tags first (in document order), then preprocessDocTags reads
      // body-level tags. So: identity (system-doc), anti-patterns
      // (system-shared), then per-event (body doc).
      vi.mocked(readFile)
        .mockResolvedValueOnce('STABLE identity (system)') // {{system-doc:docs/IDENTITY.md}}
        .mockResolvedValueOnce('STABLE shared anti-patterns (system)') // {{system-shared:...}}
        .mockResolvedValueOnce('VARIABLE doc (body)'); // {{doc:templates/per-event.md}}

      const result = await renderTemplate(
        '{{system-doc:docs/IDENTITY.md}}\n{{doc:templates/per-event.md}}\n{{system-shared:docs/anti-patterns.md}}\nfinal body',
        {},
        BASE_DIR,
      );

      // System content is concatenated in document order, body-level tags
      // are resolved in place, body-level remains in body.
      expect(result.systemPrompt).toBe(
        'STABLE identity (system)\n\nSTABLE shared anti-patterns (system)',
      );
      expect(result.body).toContain('VARIABLE doc (body)');
      expect(result.body).toContain('final body');
    });

    it('rejects {{system-shared:…}} paths that escape the shared root', async () => {
      await expect(
        renderTemplate('{{system-shared:../patch/docs/SOUL.md}}', {}, BASE_DIR),
      ).rejects.toThrow(/escapes shared root/);
    });
  });

  describe('frontmatter parsing', () => {
    it('strips a leading `---` frontmatter block from the rendered body', async () => {
      const template = ['---', 'tools: []', '---', 'visible body'].join('\n');
      const result = await renderTemplate(template, {}, BASE_DIR);
      expect(result.body).toBe('visible body');
      expect(result.systemPrompt).toBe('');
    });

    it('treats a template without an opening fence as having no frontmatter', async () => {
      const result = await renderTemplate('# heading\n\n---\nnot frontmatter', {}, BASE_DIR);
      // The `---` mid-document is not parsed as a fence — body unchanged.
      expect(result.body).toBe('# heading\n\n---\nnot frontmatter');
    });

    it('throws on malformed frontmatter (unclosed fence)', async () => {
      const template = ['---', 'tools: []', 'no closing fence here'].join('\n');
      await expect(renderTemplate(template, {}, BASE_DIR)).rejects.toThrow(/never closes it/);
    });

    it('throws when frontmatter declares an unknown top-level key (.strict() schema)', async () => {
      const template = ['---', 'unknown_field: oops', '---', 'body'].join('\n');
      await expect(renderTemplate(template, {}, BASE_DIR)).rejects.toThrow();
    });
  });
});
