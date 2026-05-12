import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildMCPBundle, cleanupMCPBundle } from '../../../src/services/tools/load-for-run';
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

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-loadforrun-tools-'));
    // Stage a bash tool the loader can discover + signature-check.
    const toolDir = join(workDir, 'pkg', 'mytool');
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, 'tool.yaml'),
      `description: Echo a value.
args:
  value:
    type: string
    description: value to echo
requires:
  - api_token
`,
    );
    await writeFile(
      join(toolDir, 'impl.sh'),
      [
        '#!/usr/bin/env bash',
        '# Args: ARG_VALUE',
        '# Requires-Env: API_TOKEN',
        'echo "{}"',
        '',
      ].join('\n'),
    );
    secretManager = await buildMockSecretManager([['api_token', 'xoxb-mock']]);
    resetAgentVersionCacheForTests();
    await initializeAgentVersion([process.cwd()]);
  });

  afterEach(async () => {
    await secretManager?.close();
    await rm(workDir, { recursive: true, force: true });
    resetAgentVersionCacheForTests();
  });

  it('resolves credentials and materializes MCP files', async () => {
    const bundle = await buildMCPBundle([{ 'module.bash': 'pkg.mytool' }], workDir, {
      agentId: 'a',
      routeId: 'r',
      requestId: 'req-load',
    });
    expect(bundle).toBeDefined();
    expect(bundle?.mcpConfigPath).toMatch(/mcp-config\.json$/);
    const creds = JSON.parse(bundle?.env['CLAWNDOM_TOOL_CREDS'] ?? '{}') as Record<
      string,
      Record<string, string>
    >;
    expect(creds['pkg_mytool']?.api_token).toBe('xoxb-mock');
    const toolConfig = JSON.parse(await readFile(bundle?.toolConfigPath ?? '', 'utf-8')) as {
      tools: Array<{ name: string; requires: string[] }>;
    };
    expect(toolConfig.tools[0]?.name).toBe('pkg_mytool');
    expect(toolConfig.tools[0]?.requires).toEqual(['api_token']);
    await cleanupMCPBundle(bundle);
  });

  it('cleanupMCPBundle removes the temp directory', async () => {
    const bundle = await buildMCPBundle([{ 'module.bash': 'pkg.mytool' }], workDir, {
      agentId: 'a',
      routeId: 'r',
      requestId: 'req-cleanup',
    });
    const tempRoot = dirname(bundle?.mcpConfigPath ?? '');
    await cleanupMCPBundle(bundle);
    await expect(readFile(bundle?.mcpConfigPath ?? '', 'utf-8')).rejects.toThrow();
    await expect(readFile(join(tempRoot, 'tool-config.json'), 'utf-8')).rejects.toThrow();
  });
});

describe('cleanupMCPBundle', () => {
  it('is a no-op when given undefined', async () => {
    await expect(cleanupMCPBundle(undefined)).resolves.toBeUndefined();
  });

  it('swallows errors from missing temp dirs', async () => {
    // Passing a bundle whose temp dir doesn't exist should not throw.
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
