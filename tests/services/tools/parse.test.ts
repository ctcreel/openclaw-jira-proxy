import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadToolDescriptor } from '../../../src/services/tools/parse';

describe('loadToolDescriptor (bash kind, no Python subprocess)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-parse-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('parses a valid bash tool.yaml', async () => {
    const toolDir = join(workDir, 'pkg', 'category', 'my-tool');
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, 'tool.yaml'),
      `description: A useful tool.
args:
  target:
    type: string
    description: The target to operate on.
requires:
  - api_token
`,
    );
    await writeFile(join(toolDir, 'impl.sh'), '#!/usr/bin/env bash\n');

    const descriptor = await loadToolDescriptor({ 'module.bash': 'pkg.category.my-tool' }, workDir);

    expect(descriptor.kind).toBe('bash');
    expect(descriptor.directory).toBe(toolDir);
    expect(descriptor.reference).toBe('pkg.category.my-tool');
    expect(descriptor.name).toBe('category_my-tool');
    expect(descriptor.description).toBe('A useful tool.');
    expect(descriptor.args.target?.type).toBe('string');
    expect(descriptor.requires).toEqual(['api_token']);
  });

  it('uses an explicit name override when provided', async () => {
    const toolDir = join(workDir, 'pkg', 'tool');
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, 'tool.yaml'),
      `description: A tool.
name: explicit_override_name
`,
    );
    await writeFile(join(toolDir, 'impl.sh'), '');

    const descriptor = await loadToolDescriptor({ 'module.bash': 'pkg.tool' }, workDir);
    expect(descriptor.name).toBe('explicit_override_name');
  });

  it('rejects a tool directory missing tool.yaml', async () => {
    const toolDir = join(workDir, 'pkg', 'missing');
    await mkdir(toolDir, { recursive: true });
    // No tool.yaml written.

    await expect(loadToolDescriptor({ 'module.bash': 'pkg.missing' }, workDir)).rejects.toThrow(
      /Missing or unreadable tool\.yaml/,
    );
  });

  it('rejects a tool.yaml without description', async () => {
    const toolDir = join(workDir, 'pkg', 'bad-yaml');
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, 'tool.yaml'),
      `args:\n  x:\n    type: string\n    description: x.\n`,
    );

    await expect(loadToolDescriptor({ 'module.bash': 'pkg.bad-yaml' }, workDir)).rejects.toThrow(
      /Invalid tool\.yaml/,
    );
  });

  it('rejects when the resolved directory does not exist', async () => {
    await expect(
      loadToolDescriptor({ 'module.bash': 'pkg.does-not-exist' }, workDir),
    ).rejects.toThrow(/Bash tool directory not found/);
  });
});
