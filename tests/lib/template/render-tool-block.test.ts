import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  renderToolBlock,
  resetToolBlockCache,
  validateToolModulesImport,
  invokeIntrospector,
} from '../../../src/lib/template/render-tool-block';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'agency_tools_sample');

describe('renderToolBlock', () => {
  beforeEach(() => {
    resetToolBlockCache();
  });

  it('returns empty string when no tools are declared', async () => {
    const result = await renderToolBlock({
      tools: [],
      agencyToolsPath: FIXTURE_PATH,
      rawFrontmatter: '',
    });
    expect(result).toBe('');
  });

  it('renders a Markdown block including the module docstring and public callables', async () => {
    const tools = [{ module: 'sample_module', requires_env: [] as string[] }];
    const rendered = await renderToolBlock({
      tools,
      agencyToolsPath: FIXTURE_PATH,
      rawFrontmatter: 'tools:\n  - module: sample_module\n',
    });

    // Module heading + module-level docstring.
    expect(rendered).toContain('## sample_module');
    expect(rendered).toContain('Sample module for tool-block rendering tests.');

    // Both public callables present. Python's `inspect.signature` (with
    // `from __future__ import annotations` in the fixture, the only way
    // to stay typing-compatible across versions) emits string annotations
    // — `'str'` rather than bare `str`. Match the exact form the
    // introspector produces so this test pins the byte contract.
    expect(rendered).toContain('### `fetch_thread(channel:');
    expect(rendered).toContain('### `post_message(channel:');

    // Order is alphabetical (the introspector sorts by name).
    const fetchIdx = rendered.indexOf('### `fetch_thread');
    const postIdx = rendered.indexOf('### `post_message');
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeGreaterThan(fetchIdx);

    // Private helper does NOT appear in the rendered docs.
    expect(rendered).not.toContain('_internal_helper');

    // Heredoc invocation example uses the canonical pattern.
    expect(rendered).toContain("bash <<'PY'");
    expect(rendered).toContain('from sample_module import post_message');
    expect(rendered).toContain('PY');
    expect(rendered).toContain('```bash');
  });

  it('emits the os.environ keyword form when the helper declares one requires_env', async () => {
    const tools = [
      {
        module: 'sample_module_with_env',
        requires_env: ['SLACK_BOT_TOKEN'],
      },
    ];
    const rendered = await renderToolBlock({
      tools,
      agencyToolsPath: FIXTURE_PATH,
      rawFrontmatter:
        'tools:\n  - module: sample_module_with_env\n    requires_env: [SLACK_BOT_TOKEN]\n',
    });

    expect(rendered).toContain('Provide SLACK_BOT_TOKEN via the matching SECRETS_CONFIG entry');
    expect(rendered).toContain("post(bot_token=os.environ['SLACK_BOT_TOKEN'])");
  });

  it('renders a module with no module-level docstring without an empty heading body', async () => {
    const tools = [{ module: 'sample_module_no_doc', requires_env: [] as string[] }];
    const rendered = await renderToolBlock({
      tools,
      agencyToolsPath: FIXTURE_PATH,
      rawFrontmatter: 'tools:\n  - module: sample_module_no_doc\n',
    });

    expect(rendered).toContain('## sample_module_no_doc');
    expect(rendered).toContain('### `bare_function()`');
  });

  it('returns byte-identical output across two renders with the same inputs', async () => {
    const tools = [{ module: 'sample_module', requires_env: [] as string[] }];
    const rawFrontmatter = 'tools:\n  - module: sample_module\n';

    const first = await renderToolBlock({ tools, agencyToolsPath: FIXTURE_PATH, rawFrontmatter });
    const second = await renderToolBlock({ tools, agencyToolsPath: FIXTURE_PATH, rawFrontmatter });

    expect(second).toBe(first);
    // The cache hit means the output bytes match exactly — this is the
    // prompt-cache invariant the renderer is designed to preserve.
  });

  it('keys the cache on (frontmatterHash, agencyToolsPath)', async () => {
    const tools = [{ module: 'sample_module', requires_env: [] as string[] }];
    const rawFrontmatter = 'tools:\n  - module: sample_module\n';

    const first = await renderToolBlock({ tools, agencyToolsPath: FIXTURE_PATH, rawFrontmatter });

    // Same key → cached identical bytes.
    const cached = await renderToolBlock({
      tools,
      agencyToolsPath: FIXTURE_PATH,
      rawFrontmatter,
    });
    expect(cached).toBe(first);

    // Distinct agencyToolsPath → fresh cache entry. The renderer embeds
    // import failures inline (so the agent sees the error rather than
    // silently nothing), so we assert the bytes diverge AND surface the
    // failure marker — confirming the cache key actually included the
    // path component.
    const otherPath = await renderToolBlock({
      tools,
      agencyToolsPath: '/nonexistent/agency/path',
      rawFrontmatter,
    });
    expect(otherPath).not.toBe(first);
    expect(otherPath).toContain('Introspection failed');
  });
});

describe('invokeIntrospector', () => {
  it('returns ok=false with ImportError on a missing module', async () => {
    const result = await invokeIntrospector(['nonexistent_module_xyz'], FIXTURE_PATH);
    expect(result.nonexistent_module_xyz).toBeDefined();
    expect(result.nonexistent_module_xyz!.ok).toBe(false);
    if (result.nonexistent_module_xyz!.ok === false) {
      expect(result.nonexistent_module_xyz!.error).toMatch(/ModuleNotFoundError|ImportError/);
    }
  });

  it('returns nothing when given an empty module list', async () => {
    const result = await invokeIntrospector([], FIXTURE_PATH);
    expect(result).toEqual({});
  });
});

describe('validateToolModulesImport', () => {
  beforeEach(() => {
    resetToolBlockCache();
  });

  it('passes when every module imports cleanly', async () => {
    await expect(
      validateToolModulesImport(['sample_module', 'sample_module_no_doc'], FIXTURE_PATH),
    ).resolves.toBeUndefined();
  });

  it('throws with a clear message when a module fails to import', async () => {
    await expect(
      validateToolModulesImport(['sample_module', 'nonexistent_xyz'], FIXTURE_PATH),
    ).rejects.toThrow(/nonexistent_xyz/);
  });

  it('is a no-op when given no modules', async () => {
    await expect(validateToolModulesImport([], FIXTURE_PATH)).resolves.toBeUndefined();
  });
});
