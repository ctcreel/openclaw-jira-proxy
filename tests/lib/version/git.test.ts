import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { readRepoVersion } from '../../../src/lib/version/git';

const execFile = promisify(execFileCallback);

describe('readRepoVersion', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-git-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function initRepo(): Promise<void> {
    await execFile('git', ['-C', workDir, 'init', '--quiet']);
    await execFile('git', ['-C', workDir, 'config', 'user.email', 'test@test.com']);
    await execFile('git', ['-C', workDir, 'config', 'user.name', 'Test']);
    await execFile('git', ['-C', workDir, 'config', 'commit.gpgsign', 'false']);
    await writeFile(join(workDir, 'README.md'), 'init');
    await execFile('git', ['-C', workDir, 'add', '-A']);
    await execFile('git', ['-C', workDir, 'commit', '-m', 'init', '--quiet']);
  }

  it('returns the HEAD sha and dirty:false on a clean repo', async () => {
    await initRepo();
    const result = await readRepoVersion(workDir);
    expect(result.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.dirty).toBe(false);
  });

  it('returns dirty:true when an untracked file is present', async () => {
    await initRepo();
    await writeFile(join(workDir, 'newfile.txt'), 'untracked');
    const result = await readRepoVersion(workDir);
    expect(result.dirty).toBe(true);
  });

  it('returns dirty:true when a tracked file is modified', async () => {
    await initRepo();
    await writeFile(join(workDir, 'README.md'), 'modified after commit');
    const result = await readRepoVersion(workDir);
    expect(result.dirty).toBe(true);
  });

  it('throws a clear error when path is not a git repository', async () => {
    // workDir exists but no `git init` — `git rev-parse HEAD` fails.
    await expect(readRepoVersion(workDir)).rejects.toThrow(/git .* failed:/);
  });

  it('throws a clear error when path does not exist', async () => {
    await expect(readRepoVersion('/nonexistent/path/here')).rejects.toThrow(/git .* failed:/);
  });
});
