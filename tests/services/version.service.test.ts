import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  initializeAgentVersion,
  getAgentVersion,
  resetAgentVersionCacheForTests,
} from '../../src/services/version.service';

const execFile = promisify(execFileCallback);

async function makeGitRepo(dir: string, fileContents = 'hello'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execFile('git', ['-C', dir, 'init', '--quiet']);
  await execFile('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
  await execFile('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await execFile('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'README.md'), fileContents);
  await execFile('git', ['-C', dir, 'add', '-A']);
  await execFile('git', ['-C', dir, 'commit', '-m', 'init', '--quiet']);
}

describe('initializeAgentVersion (sharedTools nested-repo discovery)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-version-service-'));
    resetAgentVersionCacheForTests();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    resetAgentVersionCacheForTests();
  });

  it('includes nested sharedTools repos in the version manifest', async () => {
    // Layout matches what clawndom's clonePinned produces on Winston's EC2:
    //   <cloneDir>/         ← agent's repo
    //     workspaces/winston/   ← agent.dir
    //     agency-tools/         ← nested sharedTools clone (own .git)
    //   <clawndom-checkout>/    ← Clawndom binary's checkout
    const cloneDir = join(workDir, 'winston-agency');
    const agentDir = join(cloneDir, 'workspaces', 'winston');
    const sharedToolsDir = join(cloneDir, 'agency-tools');
    const clawndomCheckout = join(workDir, 'clawndom');

    await makeGitRepo(cloneDir);
    await mkdir(agentDir, { recursive: true });
    await makeGitRepo(sharedToolsDir);
    await makeGitRepo(clawndomCheckout);

    const version = await initializeAgentVersion([agentDir], clawndomCheckout);
    const repoNames = version.repos.map((r) => r.name).sort();

    expect(repoNames).toContain('agency-tools');
    expect(repoNames).toContain('winston-agency');
    expect(repoNames).toContain('clawndom');
  });

  it('also discovers sibling repos beside the agent repo', async () => {
    // Older layout: sharedTools cloned as a sibling rather than nested.
    const cloneDir = join(workDir, 'parent', 'winston-agency');
    const agentDir = join(cloneDir, 'workspaces', 'winston');
    const sharedToolsDir = join(workDir, 'parent', 'agency-tools');
    const clawndomCheckout = join(workDir, 'clawndom');

    await makeGitRepo(cloneDir);
    await mkdir(agentDir, { recursive: true });
    await makeGitRepo(sharedToolsDir);
    await makeGitRepo(clawndomCheckout);

    const version = await initializeAgentVersion([agentDir], clawndomCheckout);
    expect(version.repos.map((r) => r.name).sort()).toContain('agency-tools');
  });

  it('produces a stable hash when only sharedTools SHAs are unchanged', async () => {
    const cloneDir = join(workDir, 'wa');
    const agentDir = join(cloneDir, 'workspaces', 'winston');
    const sharedToolsDir = join(cloneDir, 'agency-tools');
    const clawndomCheckout = join(workDir, 'clawndom');

    await makeGitRepo(cloneDir);
    await mkdir(agentDir, { recursive: true });
    await makeGitRepo(sharedToolsDir);
    await makeGitRepo(clawndomCheckout);

    const first = await initializeAgentVersion([agentDir], clawndomCheckout);
    resetAgentVersionCacheForTests();
    const second = await initializeAgentVersion([agentDir], clawndomCheckout);
    expect(first.hash).toBe(second.hash);
  });

  it('changes the hash when sharedTools advances by a commit', async () => {
    const cloneDir = join(workDir, 'wa');
    const agentDir = join(cloneDir, 'workspaces', 'winston');
    const sharedToolsDir = join(cloneDir, 'agency-tools');
    const clawndomCheckout = join(workDir, 'clawndom');

    await makeGitRepo(cloneDir);
    await mkdir(agentDir, { recursive: true });
    await makeGitRepo(sharedToolsDir);
    await makeGitRepo(clawndomCheckout);

    const before = await initializeAgentVersion([agentDir], clawndomCheckout);
    // Advance sharedTools by one commit.
    await writeFile(join(sharedToolsDir, 'bump.md'), 'bump');
    await execFile('git', ['-C', sharedToolsDir, 'add', '-A']);
    await execFile('git', ['-C', sharedToolsDir, 'commit', '-m', 'bump', '--quiet']);
    resetAgentVersionCacheForTests();
    const after = await initializeAgentVersion([agentDir], clawndomCheckout);

    expect(before.hash).not.toBe(after.hash);
  });

  it('throws in production when any involved repo is dirty', async () => {
    const cloneDir = join(workDir, 'wa');
    const agentDir = join(cloneDir, 'workspaces', 'winston');
    const sharedToolsDir = join(cloneDir, 'agency-tools');
    const clawndomCheckout = join(workDir, 'clawndom');

    await makeGitRepo(cloneDir);
    await mkdir(agentDir, { recursive: true });
    await makeGitRepo(sharedToolsDir);
    await makeGitRepo(clawndomCheckout);
    // Dirty the agency-tools clone (the nested sharedTools).
    await writeFile(join(sharedToolsDir, 'README.md'), 'modified without commit');

    const previousEnv = process.env['CLAWNDOM_ENV'];
    process.env['CLAWNDOM_ENV'] = 'production';
    try {
      await expect(
        initializeAgentVersion([agentDir], clawndomCheckout),
      ).rejects.toThrow(/uncommitted changes/);
    } finally {
      if (previousEnv === undefined) delete process.env['CLAWNDOM_ENV'];
      else process.env['CLAWNDOM_ENV'] = previousEnv;
    }
  });

  it('getAgentVersion throws if called before initialize', () => {
    expect(() => getAgentVersion()).toThrow(/called before initializeAgentVersion/);
  });
});
