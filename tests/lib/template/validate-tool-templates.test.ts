import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateToolTemplates } from '../../../src/lib/template/validate-tool-templates';
import { resetToolBlockCache } from '../../../src/lib/template/render-tool-block';
import type { ResolvedAgent } from '../../../src/services/agent-loader.service';
import type { SecretManager } from '../../../src/secrets/manager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'agency_tools_sample');

/**
 * Build a SecretManager-shaped stub with a fixed set of declared keys.
 * The validator only consumes `hasSecret`, so a structural double avoids
 * spinning up the full provider-resolution chain.
 */
function buildSecretManager(declaredKeys: readonly string[]): SecretManager {
  const declared = new Set(declaredKeys);
  return {
    hasSecret: (key: string): boolean => declared.has(key),
  } as unknown as SecretManager;
}

function buildAgent(args: {
  name: string;
  dir: string;
  templates: readonly string[];
}): ResolvedAgent {
  const { name, dir, templates } = args;
  return {
    name,
    dir,
    config: {
      routing: {
        webhook: {
          rules: templates.map((messageTemplate) => ({
            messageTemplate,
            catchUp: false,
          })),
        },
      },
      modelRules: {},
    },
  } as ResolvedAgent;
}

describe('validateToolTemplates', () => {
  // Track tmpdirs we create per test so afterEach can clean them up. Avoids
  // leaking /tmp dirs when an assertion throws mid-test.
  const cleanups: Array<() => Promise<void>> = [];

  async function buildAgentDir(templates: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'validate-tool-templates-'));
    for (const [relativePath, content] of Object.entries(templates)) {
      const fullPath = join(dir, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
    }
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    return dir;
  }

  beforeEach(() => {
    resetToolBlockCache();
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      await cleanup();
    }
  });

  it('passes silently when no template declares tools or placeholders', async () => {
    const dir = await buildAgentDir({
      'templates/x.md': 'plain body, no tools',
    });
    const agent = buildAgent({ name: 'patch', dir, templates: ['templates/x.md'] });

    await expect(
      validateToolTemplates([agent], buildSecretManager([]), new Map([['patch', FIXTURE_PATH]])),
    ).resolves.toBeUndefined();
  });

  it('passes when declarations + placeholder + secrets + module imports all resolve', async () => {
    const template = [
      '---',
      'tools:',
      '  - module: sample_module',
      '    requires_env: [SLACK_BOT_TOKEN]',
      '---',
      'body',
      '{{tools}}',
    ].join('\n');
    const dir = await buildAgentDir({ 'templates/ok.md': template });
    const agent = buildAgent({ name: 'patch', dir, templates: ['templates/ok.md'] });

    await expect(
      validateToolTemplates(
        [agent],
        buildSecretManager(['SLACK_BOT_TOKEN']),
        new Map([['patch', FIXTURE_PATH]]),
      ),
    ).resolves.toBeUndefined();
  });

  it('fails when frontmatter declares tools but the body has no {{tools}} placeholder', async () => {
    const template = [
      '---',
      'tools:',
      '  - module: sample_module',
      '---',
      'body without placeholder',
    ].join('\n');
    const dir = await buildAgentDir({ 'templates/missing-placeholder.md': template });
    const agent = buildAgent({
      name: 'patch',
      dir,
      templates: ['templates/missing-placeholder.md'],
    });

    await expect(
      validateToolTemplates([agent], buildSecretManager([]), new Map([['patch', FIXTURE_PATH]])),
    ).rejects.toThrow(/no `\{\{tools\}\}` placeholder/);
  });

  it('fails when the body has {{tools}} but frontmatter declares no tools', async () => {
    const template = '---\ntools: []\n---\nbody {{tools}}';
    const dir = await buildAgentDir({ 'templates/orphan-placeholder.md': template });
    const agent = buildAgent({
      name: 'patch',
      dir,
      templates: ['templates/orphan-placeholder.md'],
    });

    await expect(
      validateToolTemplates([agent], buildSecretManager([]), new Map([['patch', FIXTURE_PATH]])),
    ).rejects.toThrow(/declares no `tools:`/);
  });

  it('fails when a requires_env key is not declared in SecretManager', async () => {
    const template = [
      '---',
      'tools:',
      '  - module: sample_module',
      '    requires_env: [MISSING_KEY]',
      '---',
      '{{tools}}',
    ].join('\n');
    const dir = await buildAgentDir({ 'templates/missing-secret.md': template });
    const agent = buildAgent({
      name: 'patch',
      dir,
      templates: ['templates/missing-secret.md'],
    });

    await expect(
      validateToolTemplates([agent], buildSecretManager([]), new Map([['patch', FIXTURE_PATH]])),
    ).rejects.toThrow(/MISSING_KEY/);
  });

  it('fails when a declared module fails to import under agencyToolsPath', async () => {
    const template = [
      '---',
      'tools:',
      '  - module: definitely_not_a_real_module_xyz',
      '---',
      '{{tools}}',
    ].join('\n');
    const dir = await buildAgentDir({ 'templates/missing-module.md': template });
    const agent = buildAgent({
      name: 'patch',
      dir,
      templates: ['templates/missing-module.md'],
    });

    await expect(
      validateToolTemplates([agent], buildSecretManager([]), new Map([['patch', FIXTURE_PATH]])),
    ).rejects.toThrow(/definitely_not_a_real_module_xyz/);
  });

  it('fails with a clear message when the agent declares tools but has no sharedTools', async () => {
    const template = ['---', 'tools:', '  - module: sample_module', '---', '{{tools}}'].join('\n');
    const dir = await buildAgentDir({ 'templates/no-shared-tools.md': template });
    const agent = buildAgent({
      name: 'no-tools-agent',
      dir,
      templates: ['templates/no-shared-tools.md'],
    });

    await expect(validateToolTemplates([agent], buildSecretManager([]), new Map())).rejects.toThrow(
      /no `sharedTools` configured/,
    );
  });

  it('aggregates multiple failures across templates into one thrown error', async () => {
    const goodTemplate = [
      '---',
      'tools:',
      '  - module: sample_module',
      '    requires_env: [DECLARED_KEY]',
      '---',
      '{{tools}}',
    ].join('\n');
    const badSecretTemplate = [
      '---',
      'tools:',
      '  - module: sample_module',
      '    requires_env: [MISSING_KEY_A]',
      '---',
      '{{tools}}',
    ].join('\n');
    const badModuleTemplate = [
      '---',
      'tools:',
      '  - module: also_not_a_real_module_qrs',
      '---',
      '{{tools}}',
    ].join('\n');

    const dir = await buildAgentDir({
      'templates/good.md': goodTemplate,
      'templates/bad-secret.md': badSecretTemplate,
      'templates/bad-module.md': badModuleTemplate,
    });
    const agent = buildAgent({
      name: 'patch',
      dir,
      templates: ['templates/good.md', 'templates/bad-secret.md', 'templates/bad-module.md'],
    });

    let caught: unknown;
    try {
      await validateToolTemplates(
        [agent],
        buildSecretManager(['DECLARED_KEY']),
        new Map([['patch', FIXTURE_PATH]]),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('MISSING_KEY_A');
    expect(message).toContain('also_not_a_real_module_qrs');
  });
});
