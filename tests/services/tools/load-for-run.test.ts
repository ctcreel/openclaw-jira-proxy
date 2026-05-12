import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildMCPBundle,
  cleanupMCPBundle,
  resolveSecretFromAliases,
} from '../../../src/services/tools/load-for-run';
import { buildMockSecretManager } from '../../helpers/mock-secret-manager';
import {
  initializeAgentVersion,
  resetAgentVersionCacheForTests,
} from '../../../src/services/version.service';
import type { SecretManager } from '../../../src/secrets/manager';

describe('buildMCPBundle', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-loadforrun-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns undefined when no tools are declared', async () => {
    const result = await buildMCPBundle(undefined, workDir, {
      agentId: 'a',
      routeId: 'r',
      requestId: 'req',
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for an empty tools list', async () => {
    const result = await buildMCPBundle([], workDir, {
      agentId: 'a',
      routeId: 'r',
      requestId: 'req',
    });
    expect(result).toBeUndefined();
  });
});

describe('buildMCPBundle (with tools)', () => {
  let workDir: string;
  let secretManager: SecretManager | undefined;
  let originalPythonPath: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-loadforrun-tools-'));
    // Stage a Python tool the loader can discover + signature-check.
    const pkgDir = join(workDir, 'fixture_lfr_pkg');
    const toolDir = join(pkgDir, 'mytool');
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(pkgDir, '__init__.py'), '');
    await writeFile(join(toolDir, '__init__.py'), '');
    await writeFile(
      join(toolDir, 'tool.yaml'),
      `description: Echo a value.
args:
  value:
    type: string
    description: value to echo
secrets:
  api_token: [API_TOKEN_NEW, API_TOKEN_LEGACY]
`,
    );
    await writeFile(
      join(toolDir, 'impl.py'),
      `def invoke(*, value, api_token):
    return {"echoed": value}
`,
    );
    originalPythonPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = `${workDir}:${originalPythonPath ?? ''}`;
    // The mock secret manager is keyed by binding key. The tool's first
    // alias (API_TOKEN_NEW) is what we wire here — load-for-run picks it
    // up as the first-match, and the legacy alias goes unused. Either
    // would resolve.
    secretManager = await buildMockSecretManager([['API_TOKEN_NEW', 'xoxb-mock']]);
    resetAgentVersionCacheForTests();
    await initializeAgentVersion([process.cwd()]);
  });

  afterEach(async () => {
    if (originalPythonPath === undefined) delete process.env['PYTHONPATH'];
    else process.env['PYTHONPATH'] = originalPythonPath;
    await secretManager?.close();
    await rm(workDir, { recursive: true, force: true });
    resetAgentVersionCacheForTests();
  });

  it('resolves credentials by canonical name from the first matching alias', async () => {
    const bundle = await buildMCPBundle(
      [{ 'module.python': 'fixture_lfr_pkg.mytool' }],
      workDir,
      {
        agentId: 'a',
        routeId: 'r',
        requestId: 'req-load',
      },
    );
    expect(bundle).toBeDefined();
    expect(bundle?.mcpConfigPath).toMatch(/mcp-config\.json$/);
    const creds = JSON.parse(bundle?.env['CLAWNDOM_TOOL_CREDS'] ?? '{}') as Record<
      string,
      Record<string, string>
    >;
    // Per-tool creds are keyed by canonical name (api_token), not alias.
    expect(creds['fixture_lfr_pkg_mytool']?.['api_token']).toBe('xoxb-mock');
    const toolConfig = JSON.parse(await readFile(bundle?.toolConfigPath ?? '', 'utf-8')) as {
      tools: Array<{
        name: string;
        secrets: Array<{ canonical: string; aliases: string[] }>;
      }>;
    };
    expect(toolConfig.tools[0]?.name).toBe('fixture_lfr_pkg_mytool');
    expect(toolConfig.tools[0]?.secrets).toEqual([
      { canonical: 'api_token', aliases: ['API_TOKEN_NEW', 'API_TOKEN_LEGACY'] },
    ]);
    await cleanupMCPBundle(bundle);
  });

  it('cleanupMCPBundle removes the temp directory', async () => {
    const bundle = await buildMCPBundle(
      [{ 'module.python': 'fixture_lfr_pkg.mytool' }],
      workDir,
      {
        agentId: 'a',
        routeId: 'r',
        requestId: 'req-cleanup',
      },
    );
    const tempRoot = dirname(bundle?.mcpConfigPath ?? '');
    await cleanupMCPBundle(bundle);
    await expect(readFile(bundle?.mcpConfigPath ?? '', 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tempRoot, 'tool-config.json'), 'utf-8')).rejects.toThrow();
  });
});

describe('resolveSecretFromAliases', () => {
  let secretManager: SecretManager;

  beforeEach(async () => {
    secretManager = await buildMockSecretManager([
      ['LEGACY_KEY', 'old-value'],
      ['NEW_KEY', 'new-value'],
    ]);
  });

  afterEach(async () => {
    await secretManager.close();
  });

  it('returns the first matching alias value', () => {
    const result = resolveSecretFromAliases(
      { canonical: 'token', aliases: ['NEW_KEY', 'LEGACY_KEY'] },
      secretManager,
      'mytool',
    );
    expect(result).toBe('new-value');
  });

  it('falls through to a later alias when the earlier one is unregistered', () => {
    const result = resolveSecretFromAliases(
      { canonical: 'token', aliases: ['UNREGISTERED', 'NEW_KEY'] },
      secretManager,
      'mytool',
    );
    expect(result).toBe('new-value');
  });

  it('throws a clear error naming the canonical and aliases when none match', () => {
    expect(() =>
      resolveSecretFromAliases(
        { canonical: 'missing', aliases: ['NOPE_A', 'NOPE_B'] },
        secretManager,
        'mytool',
      ),
    ).toThrow(/needs secret 'missing' but none of its declared aliases \[NOPE_A, NOPE_B\]/);
  });
});

describe('cleanupMCPBundle', () => {
  it('is a no-op when given undefined', async () => {
    await expect(cleanupMCPBundle(undefined)).resolves.toBeUndefined();
  });

  it('swallows errors from missing temp dirs', async () => {
    const missingRoot = join(tmpdir(), 'spe-2078-nonexistent-cleanup');
    await expect(
      cleanupMCPBundle({
        mcpConfigPath: join(missingRoot, 'mcp-config.json'),
        toolConfigPath: join(missingRoot, 'tool-config.json'),
        env: {},
      }),
    ).resolves.toBeUndefined();
  });
});
