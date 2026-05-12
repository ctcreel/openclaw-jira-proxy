import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadToolDescriptor } from '../../../src/services/tools/parse';

describe('loadToolDescriptor', () => {
  let workDir: string;
  let originalPythonPath: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-parse-'));
    originalPythonPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = `${workDir}:${originalPythonPath ?? ''}`;
  });

  afterEach(async () => {
    if (originalPythonPath === undefined) delete process.env['PYTHONPATH'];
    else process.env['PYTHONPATH'] = originalPythonPath;
    await rm(workDir, { recursive: true, force: true });
  });

  async function stagePythonTool(
    pkg: string,
    subpath: readonly string[],
    yaml: string,
  ): Promise<string> {
    const pkgDir = join(workDir, pkg);
    const leafDir = join(pkgDir, ...subpath);
    await mkdir(leafDir, { recursive: true });
    await writeFile(join(pkgDir, '__init__.py'), '');
    let cursor = pkgDir;
    for (const segment of subpath) {
      cursor = join(cursor, segment);
      await writeFile(join(cursor, '__init__.py'), '');
    }
    await writeFile(join(leafDir, 'tool.yaml'), yaml);
    await writeFile(join(leafDir, 'impl.py'), 'def invoke(**_):\n    return None\n');
    return leafDir;
  }

  it('parses a tool.yaml with array-form secret aliases', async () => {
    const toolDir = await stagePythonTool(
      'fixture_parse_pkg',
      ['category', 'my_tool'],
      `description: A useful tool.
args:
  target:
    type: string
    description: The target to operate on.
secrets:
  api_token: [API_TOKEN_NEW, API_TOKEN_LEGACY]
`,
    );

    const descriptor = await loadToolDescriptor(
      { 'module.python': 'fixture_parse_pkg.category.my_tool' },
      workDir,
    );

    expect(descriptor.directory).toBe(toolDir);
    expect(descriptor.reference).toBe('fixture_parse_pkg.category.my_tool');
    expect(descriptor.name).toBe('category_my_tool');
    expect(descriptor.description).toBe('A useful tool.');
    expect(descriptor.args['target']?.type).toBe('string');
    expect(descriptor.secrets).toEqual([
      { canonical: 'api_token', aliases: ['API_TOKEN_NEW', 'API_TOKEN_LEGACY'] },
    ]);
  });

  it('parses a tool.yaml with single-string secret alias (shorthand)', async () => {
    await stagePythonTool(
      'fixture_parse_pkg_shorthand',
      ['tool'],
      `description: A tool.
secrets:
  api_token: ONE_TRUE_KEY
`,
    );

    const descriptor = await loadToolDescriptor(
      { 'module.python': 'fixture_parse_pkg_shorthand.tool' },
      workDir,
    );
    expect(descriptor.secrets).toEqual([
      { canonical: 'api_token', aliases: ['ONE_TRUE_KEY'] },
    ]);
  });

  it('uses an explicit name override when provided', async () => {
    await stagePythonTool(
      'fixture_parse_pkg_named',
      ['tool'],
      `description: A tool.
name: explicit_override_name
`,
    );

    const descriptor = await loadToolDescriptor(
      { 'module.python': 'fixture_parse_pkg_named.tool' },
      workDir,
    );
    expect(descriptor.name).toBe('explicit_override_name');
  });

  it('rejects a tool directory missing tool.yaml', async () => {
    const pkgDir = join(workDir, 'fixture_parse_pkg_missing');
    const leafDir = join(pkgDir, 'missing');
    await mkdir(leafDir, { recursive: true });
    await writeFile(join(pkgDir, '__init__.py'), '');
    await writeFile(join(leafDir, '__init__.py'), '');
    // No tool.yaml written.

    await expect(
      loadToolDescriptor({ 'module.python': 'fixture_parse_pkg_missing.missing' }, workDir),
    ).rejects.toThrow(/Missing or unreadable tool\.yaml/);
  });

  it('rejects a tool.yaml without description', async () => {
    await stagePythonTool(
      'fixture_parse_pkg_bad',
      ['bad_yaml'],
      `args:\n  x:\n    type: string\n    description: x.\n`,
    );

    await expect(
      loadToolDescriptor({ 'module.python': 'fixture_parse_pkg_bad.bad_yaml' }, workDir),
    ).rejects.toThrow(/Invalid tool\.yaml/);
  });

  it('rejects when the resolved directory does not exist', async () => {
    const pkgDir = join(workDir, 'fixture_parse_pkg_partial');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, '__init__.py'), '');

    await expect(
      loadToolDescriptor(
        { 'module.python': 'fixture_parse_pkg_partial.does_not_exist' },
        workDir,
      ),
    ).rejects.toThrow(/Python tool directory not found/);
  });
});
