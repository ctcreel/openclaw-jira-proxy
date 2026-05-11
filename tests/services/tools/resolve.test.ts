import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveToolDirectory } from '../../../src/services/tools/resolve';

describe('resolveToolDirectory (bash)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-resolve-bash-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('resolves a bash reference to a directory relative to agentDir', async () => {
    const tool = join(workDir, 'pkg', 'tools', 'my-tool');
    await mkdir(tool, { recursive: true });
    const resolved = await resolveToolDirectory({ 'module.bash': 'pkg.tools.my-tool' }, workDir);
    expect(resolved).toBe(tool);
  });

  it('throws when the bash tool directory does not exist', async () => {
    await expect(
      resolveToolDirectory({ 'module.bash': 'missing.dir' }, workDir),
    ).rejects.toThrow(/Bash tool directory not found/);
  });
});

describe('resolveToolDirectory (python)', () => {
  let workDir: string;
  let originalPythonPath: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-resolve-py-'));
    // Real Python package layout for importlib.find_spec to resolve.
    const pkgRoot = join(workDir, 'fixture_pkg');
    const subPkg = join(pkgRoot, 'category', 'mytool');
    await mkdir(subPkg, { recursive: true });
    await writeFile(join(pkgRoot, '__init__.py'), '');
    await writeFile(join(pkgRoot, 'category', '__init__.py'), '');
    await writeFile(join(subPkg, '__init__.py'), '');
    originalPythonPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = workDir + ':' + (originalPythonPath ?? '');
  });

  afterEach(async () => {
    if (originalPythonPath === undefined) delete process.env['PYTHONPATH'];
    else process.env['PYTHONPATH'] = originalPythonPath;
    await rm(workDir, { recursive: true, force: true });
  });

  it('resolves a python reference via importlib.find_spec', async () => {
    const resolved = await resolveToolDirectory(
      { 'module.python': 'fixture_pkg.category.mytool' },
      workDir,
    );
    expect(resolved).toBe(join(workDir, 'fixture_pkg', 'category', 'mytool'));
  });

  it('throws when the top-level python package is not importable', async () => {
    await expect(
      resolveToolDirectory(
        { 'module.python': 'definitely_not_a_real_package_xyz.tool' },
        workDir,
      ),
    ).rejects.toThrow(/Failed to locate Python package/);
  });

  it('throws when the package resolves but the leaf directory is missing', async () => {
    await expect(
      resolveToolDirectory({ 'module.python': 'fixture_pkg.does_not_exist' }, workDir),
    ).rejects.toThrow(/Python tool directory not found/);
  });
});
