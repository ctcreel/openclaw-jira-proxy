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

  it('renders {{ payload }} as full JSON string', async () => {
    const payload = { issue: { key: 'SPE-123' } };
    const result = await renderTemplate('{{ payload }}', payload, BASE_DIR);
    expect(result).toBe(JSON.stringify(payload, null, 2));
  });

  it('resolves top-level payload keys via Nunjucks', async () => {
    const payload = { issue: { key: 'SPE-456' } };
    const result = await renderTemplate('{{ issue.key }}', payload, BASE_DIR);
    expect(result).toBe('SPE-456');
  });

  it('inlines file contents for relative {{doc:...}} tags resolved under baseDir', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('# Instructions\nDo the thing.');

    const result = await renderTemplate('{{doc:docs/jira-policy.md}}', { foo: 'bar' }, BASE_DIR);

    expect(readFile).toHaveBeenCalledWith('/agents/patch/docs/jira-policy.md', 'utf-8');
    expect(result).toBe('# Instructions\nDo the thing.');
  });

  it('propagates read errors instead of masking them with a fallback', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

    await expect(renderTemplate('{{doc:missing/file.md}}', {}, BASE_DIR)).rejects.toThrow('ENOENT');
  });

  it('renders missing field as empty string', async () => {
    const result = await renderTemplate('value={{ nonexistent }}', { foo: 'bar' }, BASE_DIR);
    expect(result).toBe('value=');
  });

  it('handles both doc tags and Nunjucks variables in the same template', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('file content here');

    const result = await renderTemplate(
      'Key: {{ issue.key }}\nDoc: {{doc:docs/policy.md}}',
      { issue: { key: 'SPE-789' } },
      BASE_DIR,
    );

    expect(result).toBe('Key: SPE-789\nDoc: file content here');
  });

  it('handles multiple doc tags', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('first file').mockResolvedValueOnce('second file');

    const result = await renderTemplate(
      '{{doc:policies/a.md}} and {{doc:policies/b.md}}',
      {},
      BASE_DIR,
    );

    expect(result).toBe('first file and second file');
  });

  it('resolves {{shared:...}} from the sibling "shared" directory', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('# Engineering Pipeline\nShared content.');

    const result = await renderTemplate('{{shared:sc0red-engineering-pipeline.md}}', {}, BASE_DIR);

    expect(readFile).toHaveBeenCalledWith('/agents/shared/sc0red-engineering-pipeline.md', 'utf-8');
    expect(result).toBe('# Engineering Pipeline\nShared content.');
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

    expect(result).toBe('agent-only body then shared body');
  });
});
