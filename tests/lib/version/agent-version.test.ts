import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { computeAgentVersion, dirtyRepos } from '../../../src/lib/version/agent-version';

const execFile = promisify(execFileCallback);

async function gitInit(dir: string): Promise<void> {
  await execFile('git', ['-C', dir, 'init', '--quiet']);
  await execFile('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  await execFile('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await execFile('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

async function gitCommitAll(dir: string, message: string): Promise<void> {
  await execFile('git', ['-C', dir, 'add', '-A']);
  await execFile('git', ['-C', dir, 'commit', '-m', message, '--quiet', '--allow-empty']);
}

describe('computeAgentVersion', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-version-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('produces a hash and per-repo breakdown for a clean repo', async () => {
    const repoA = join(workDir, 'repo-a');
    await execFile('mkdir', ['-p', repoA]);
    await gitInit(repoA);
    await writeFile(join(repoA, 'README.md'), 'a');
    await gitCommitAll(repoA, 'init');

    const result = await computeAgentVersion([{ name: 'repo-a', path: repoA }]);
    expect(result.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]?.name).toBe('repo-a');
    expect(result.repos[0]?.dirty).toBe(false);
  });

  it('returns dirty=true when the repo has uncommitted changes', async () => {
    const repo = join(workDir, 'repo');
    await execFile('mkdir', ['-p', repo]);
    await gitInit(repo);
    await writeFile(join(repo, 'README.md'), 'first');
    await gitCommitAll(repo, 'init');
    await writeFile(join(repo, 'README.md'), 'second uncommitted');

    const result = await computeAgentVersion([{ name: 'repo', path: repo }]);
    expect(result.repos[0]?.dirty).toBe(true);
    expect(dirtyRepos(result)).toEqual(['repo']);
  });

  it('produces a stable hash regardless of input order', async () => {
    const a = join(workDir, 'a');
    const b = join(workDir, 'b');
    await execFile('mkdir', ['-p', a]);
    await execFile('mkdir', ['-p', b]);
    await gitInit(a);
    await writeFile(join(a, 'f'), 'a');
    await gitCommitAll(a, 'a');
    await gitInit(b);
    await writeFile(join(b, 'f'), 'b');
    await gitCommitAll(b, 'b');

    const order1 = await computeAgentVersion([
      { name: 'a', path: a },
      { name: 'b', path: b },
    ]);
    const order2 = await computeAgentVersion([
      { name: 'b', path: b },
      { name: 'a', path: a },
    ]);
    expect(order1.hash).toBe(order2.hash);
  });

  it('produces different hashes when SHAs differ', async () => {
    const repo = join(workDir, 'repo');
    await execFile('mkdir', ['-p', repo]);
    await gitInit(repo);
    await writeFile(join(repo, 'f'), 'first');
    await gitCommitAll(repo, 'init');
    const first = await computeAgentVersion([{ name: 'repo', path: repo }]);

    await writeFile(join(repo, 'f'), 'second');
    await gitCommitAll(repo, 'second');
    const second = await computeAgentVersion([{ name: 'repo', path: repo }]);

    expect(first.hash).not.toBe(second.hash);
  });

  it('returns no dirty repos when everything is clean', async () => {
    const repo = join(workDir, 'clean');
    await execFile('mkdir', ['-p', repo]);
    await gitInit(repo);
    await writeFile(join(repo, 'f'), 'x');
    await gitCommitAll(repo, 'init');
    const result = await computeAgentVersion([{ name: 'clean', path: repo }]);
    expect(dirtyRepos(result)).toEqual([]);
  });
});
