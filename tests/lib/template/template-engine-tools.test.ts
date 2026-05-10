import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTemplate } from '../../../src/lib/template/template-engine';
import { resetToolBlockCache } from '../../../src/lib/template/render-tool-block';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'agency_tools_sample');

/**
 * Integration tests for the `{{tools}}` placeholder. Unlike
 * `template-engine.test.ts`, this suite does NOT mock `node:fs/promises` —
 * the Python introspector subprocess + the fixture sample modules must run
 * for real. These tests are the byte-stability regression guard for the
 * SPE-2070 prompt-cache invariant: the same template + same payload must
 * produce identical system-prompt bytes across runs.
 */
describe('renderTemplate — {{tools}} placeholder', () => {
  let tmpDir: string | undefined;
  let agentDir: string | undefined;

  beforeEach(async () => {
    resetToolBlockCache();
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    // Create an agent dir so {{doc:…}} / {{shared:…}} resolution that
    // co-exists with {{tools}} can read real files.
    tmpDir = await mkdtemp(join(tmpdir(), 'template-engine-tools-'));
    agentDir = join(tmpDir, 'agent');
    await mkdir(agentDir, { recursive: true });
  });

  it('renders {{tools}} into the systemPrompt slot (not the body)', async () => {
    const template = [
      '---',
      'tools:',
      '  - module: sample_module',
      '---',
      'event-specific body content',
      '{{tools}}',
      'more body',
    ].join('\n');

    const result = await renderTemplate(template, {}, agentDir!, {
      agencyToolsPath: FIXTURE_PATH,
    });

    // Body has no rendered tool block — only event content.
    expect(result.body).not.toContain('## sample_module');
    expect(result.body).not.toContain("bash <<'PY'");
    expect(result.body).toContain('event-specific body content');
    expect(result.body).toContain('more body');

    // System prompt has the rendered tool block.
    expect(result.systemPrompt).toContain('## sample_module');
    expect(result.systemPrompt).toContain('post_message');
    expect(result.systemPrompt).toContain('fetch_thread');
    expect(result.systemPrompt).toContain("bash <<'PY'");
  });

  it('produces byte-identical systemPrompt for two renders with different payloads', async () => {
    // The byte-stability invariant: the cacheable system slot must not
    // depend on per-event payload data. If the system bytes drift, the
    // Anthropic prompt cache misses on every run and the SPE-2070 cost
    // savings evaporate silently.
    const template = [
      '---',
      'tools:',
      '  - module: sample_module',
      '---',
      'event payload: {{ event.id }}',
      '{{tools}}',
    ].join('\n');

    const first = await renderTemplate(template, { event: { id: 'evt-001' } }, agentDir!, {
      agencyToolsPath: FIXTURE_PATH,
    });
    const second = await renderTemplate(template, { event: { id: 'evt-002' } }, agentDir!, {
      agencyToolsPath: FIXTURE_PATH,
    });

    expect(second.systemPrompt).toBe(first.systemPrompt);
    // And the body DID change — confirms the test setup actually varies
    // the payload (otherwise byte-equality would be trivially true).
    expect(second.body).not.toBe(first.body);
    expect(first.body).toContain('evt-001');
    expect(second.body).toContain('evt-002');
  });

  it('preserves document order across {{system-shared:…}} and {{tools}}', async () => {
    // Document order matters for prompt-cache stability — Anthropic keys
    // on the prefix of the system block. Two templates that declare the
    // same system tags in different order produce different cache keys
    // and never share a hit. The tag ordering is what the author
    // controls, so the renderer honours it strictly.
    const sharedDir = join(tmpDir!, 'shared');
    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(sharedDir, 'identity.md'), 'IDENTITY content', 'utf-8');

    const template = [
      '---',
      'tools:',
      '  - module: sample_module',
      '---',
      '{{system-shared:identity.md}}',
      '{{tools}}',
      'body',
    ].join('\n');

    const result = await renderTemplate(template, {}, agentDir!, {
      agencyToolsPath: FIXTURE_PATH,
    });

    // Identity content appears before the tool block heading in the
    // concatenated system prompt.
    const identityIdx = result.systemPrompt.indexOf('IDENTITY content');
    const toolsIdx = result.systemPrompt.indexOf('## sample_module');
    expect(identityIdx).toBeGreaterThan(-1);
    expect(toolsIdx).toBeGreaterThan(identityIdx);
  });

  it('renders {{tools}} as empty when the template declares no tools', async () => {
    // Boot validation rejects this combination, but the template engine
    // is also invoked from tests and ad-hoc tooling outside the boot
    // walk — render an empty block rather than throwing so the runtime
    // contract stays simple.
    const template = '---\ntools: []\n---\nbefore\n{{tools}}\nafter';

    const result = await renderTemplate(template, {}, agentDir!, {
      agencyToolsPath: FIXTURE_PATH,
    });

    expect(result.systemPrompt).toBe('');
    expect(result.body).toContain('before');
    expect(result.body).toContain('after');
  });

  it('throws when frontmatter declares tools but no agencyToolsPath was provided', async () => {
    const template = ['---', 'tools:', '  - module: sample_module', '---', '{{tools}}'].join('\n');

    await expect(renderTemplate(template, {}, agentDir!)).rejects.toThrow(/agencyToolsPath/);
  });
});
