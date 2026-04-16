import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadAgents,
  slugifyRepoUrl,
  type GitClient,
} from '../../src/services/agent-loader.service';
import type { AgentEntry } from '../../src/config';

describe('slugifyRepoUrl', () => {
  it('derives a flat name from an SSH URL', () => {
    expect(slugifyRepoUrl('git@github.com:SC0RED/the-agency.git')).toBe('SC0RED__the-agency');
  });

  it('derives a flat name from an HTTPS URL', () => {
    expect(slugifyRepoUrl('https://github.com/SC0RED/the-agency.git')).toBe('SC0RED__the-agency');
  });

  it('tolerates URLs without the .git suffix', () => {
    expect(slugifyRepoUrl('https://github.com/SC0RED/the-agency')).toBe('SC0RED__the-agency');
  });

  it('throws on URLs too short to derive org/repo', () => {
    expect(() => slugifyRepoUrl('garbage')).toThrow(/Cannot derive clone directory/);
  });
});

describe('loadAgents', () => {
  let workspace: string;
  let configDir: string;
  let fakeRemotes: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'clawndom-loader-'));
    configDir = join(workspace, 'config');
    fakeRemotes = join(workspace, 'remotes');
    await mkdir(fakeRemotes, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /**
   * Fake Git client that mimics a clone by copying a prepared directory tree
   * from `fakeRemotes/<slug>` into the expected clone directory. Keeps the
   * test filesystem self-contained — no real network, no real git.
   */
  function makeFakeGit(): GitClient & {
    calls: Array<{ repo: string; dir: string; ref?: string }>;
  } {
    const calls: Array<{ repo: string; dir: string; ref?: string }> = [];
    return {
      calls,
      async cloneOrPull(repoUrl, cloneDir, ref) {
        calls.push({ repo: repoUrl, dir: cloneDir, ref });
        const source = join(fakeRemotes, slugifyRepoUrl(repoUrl));
        await mkdir(cloneDir, { recursive: true });
        // shallow copy via platform-neutral recursive mkdir + file walk
        await copyTree(source, cloneDir);
      },
    };
  }

  async function writeAgentRepo(repoSlug: string, files: Record<string, string>): Promise<string> {
    const repoRoot = join(fakeRemotes, repoSlug);
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(repoRoot, relativePath);
      await mkdir(join(fullPath, '..'), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
    }
    return repoRoot;
  }

  it('clones a single-agent repo and parses its clawndom.yaml', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': [
        'routing:',
        '  jira:',
        '    rules:',
        '      - name: bug-in-planning',
        '        condition:',
        '          all_of:',
        '            - equals:',
        '                field: issue.fields.issuetype.name',
        '                value: Bug',
        '        messageTemplate: templates/bug-plan.md',
        '',
      ].join('\n'),
    });

    const git = makeFakeGit();
    const entries: AgentEntry[] = [
      { name: 'patch', repo: 'git@github.com:SC0RED/patch-agent.git' },
    ];

    const resolved = await loadAgents(entries, configDir, git);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe('patch');
    expect(resolved[0]!.dir).toBe(join(configDir, 'SC0RED__patch-agent'));

    const rules = resolved[0]!.config.routing.jira!.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]!.name).toBe('bug-in-planning');
    expect(rules[0]!.messageTemplate).toBe('templates/bug-plan.md');

    expect(git.calls).toHaveLength(1);
  });

  it('dedupes clones when multiple agents share the same repo', async () => {
    await writeAgentRepo('SC0RED__the-agency', {
      'workspaces/patch/clawndom.yaml': 'routing: {}\n',
      'workspaces/scarlett/clawndom.yaml': 'routing: {}\n',
    });

    const git = makeFakeGit();
    const entries: AgentEntry[] = [
      {
        name: 'patch',
        repo: 'git@github.com:SC0RED/the-agency.git',
        path: 'workspaces/patch',
      },
      {
        name: 'scarlett',
        repo: 'git@github.com:SC0RED/the-agency.git',
        path: 'workspaces/scarlett',
      },
    ];

    const resolved = await loadAgents(entries, configDir, git);

    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.dir).toBe(join(configDir, 'SC0RED__the-agency', 'workspaces/patch'));
    expect(resolved[1]!.dir).toBe(join(configDir, 'SC0RED__the-agency', 'workspaces/scarlett'));
    expect(git.calls).toHaveLength(1);
  });

  it('preserves config order in the returned array', async () => {
    await writeAgentRepo('SC0RED__the-agency', {
      'workspaces/patch/clawndom.yaml': 'routing: {}\n',
      'workspaces/scarlett/clawndom.yaml': 'routing: {}\n',
    });

    const entries: AgentEntry[] = [
      {
        name: 'scarlett',
        repo: 'git@github.com:SC0RED/the-agency.git',
        path: 'workspaces/scarlett',
      },
      {
        name: 'patch',
        repo: 'git@github.com:SC0RED/the-agency.git',
        path: 'workspaces/patch',
      },
    ];

    const resolved = await loadAgents(entries, configDir, makeFakeGit());
    expect(resolved.map((agent) => agent.name)).toEqual(['scarlett', 'patch']);
  });

  it('throws when the same agent name is declared twice', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': 'routing: {}\n',
    });

    const entries: AgentEntry[] = [
      { name: 'patch', repo: 'git@github.com:SC0RED/patch-agent.git' },
      { name: 'patch', repo: 'git@github.com:SC0RED/patch-agent.git' },
    ];

    await expect(loadAgents(entries, configDir, makeFakeGit())).rejects.toThrow(
      /Duplicate agent name/,
    );
  });

  it('throws when a cloned repo is missing clawndom.yaml', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'README.md': 'nothing here',
    });

    const entries: AgentEntry[] = [
      { name: 'patch', repo: 'git@github.com:SC0RED/patch-agent.git' },
    ];

    await expect(loadAgents(entries, configDir, makeFakeGit())).rejects.toThrow();
  });

  it('throws when clawndom.yaml violates the schema', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': [
        'routing:',
        '  jira:',
        '    rules:',
        '      - condition:',
        '          matches:',
        '            field: x',
        '            pattern: "["',
        '',
      ].join('\n'),
    });

    const entries: AgentEntry[] = [
      { name: 'patch', repo: 'git@github.com:SC0RED/patch-agent.git' },
    ];

    await expect(loadAgents(entries, configDir, makeFakeGit())).rejects.toThrow();
  });

  it('forwards the ref to the git client when supplied', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': 'routing: {}\n',
    });

    const git = makeFakeGit();
    const entries: AgentEntry[] = [
      {
        name: 'patch',
        repo: 'git@github.com:SC0RED/patch-agent.git',
        ref: 'release-1.2',
      },
    ];

    await loadAgents(entries, configDir, git);
    expect(git.calls[0]!.ref).toBe('release-1.2');
  });
});

/** Platform-neutral recursive copy for the fake-git implementation. */
async function copyTree(source: string, destination: string): Promise<void> {
  const { readdir, stat, copyFile } = await import('node:fs/promises');
  const entries = await readdir(source);
  for (const entry of entries) {
    const from = join(source, entry);
    const to = join(destination, entry);
    const stats = await stat(from);
    if (stats.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyTree(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}
