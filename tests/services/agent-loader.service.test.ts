import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadAgents,
  slugifyRepoUrl,
  type GitClient,
} from '../../src/services/agent-loader.service';
import { agentEntrySchema, sharedToolsSchema } from '../../src/config';
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
    pinnedCalls: Array<{ repo: string; dir: string; ref: string }>;
    failPinnedWith?: Error;
  } {
    const calls: Array<{ repo: string; dir: string; ref?: string }> = [];
    const pinnedCalls: Array<{ repo: string; dir: string; ref: string }> = [];
    const fake = {
      calls,
      pinnedCalls,
      failPinnedWith: undefined as Error | undefined,
      async cloneOrPull(repoUrl: string, cloneDir: string, ref?: string) {
        calls.push({ repo: repoUrl, dir: cloneDir, ref });
        const source = join(fakeRemotes, slugifyRepoUrl(repoUrl));
        await mkdir(cloneDir, { recursive: true });
        // shallow copy via platform-neutral recursive mkdir + file walk
        await copyTree(source, cloneDir);
      },
      async clonePinned(repoUrl: string, cloneDir: string, ref: string) {
        pinnedCalls.push({ repo: repoUrl, dir: cloneDir, ref });
        if (fake.failPinnedWith) throw fake.failPinnedWith;
        // Real impl writes a .git directory; for the fake we just need the
        // path to exist so subsequent existsSync-style checks would succeed.
        await mkdir(cloneDir, { recursive: true });
      },
    };
    return fake;
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

  it('does not call clonePinned when sharedTools is absent (back-compat)', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': 'routing: {}\n',
    });

    const git = makeFakeGit();
    const entries: AgentEntry[] = [
      { name: 'patch', repo: 'git@github.com:SC0RED/patch-agent.git' },
    ];

    await loadAgents(entries, configDir, git);
    expect(git.pinnedCalls).toHaveLength(0);
  });

  it('clones sharedTools at the pinned ref into <cloneDir>/<path>', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': 'routing: {}\n',
    });

    const git = makeFakeGit();
    const entries: AgentEntry[] = [
      {
        name: 'patch',
        repo: 'git@github.com:SC0RED/patch-agent.git',
        sharedTools: {
          repo: 'git@github.com:SC0RED/agency-tools.git',
          ref: 'v1.0.0',
          path: 'agency-tools',
        },
      },
    ];

    await loadAgents(entries, configDir, git);

    expect(git.pinnedCalls).toEqual([
      {
        repo: 'git@github.com:SC0RED/agency-tools.git',
        dir: join(configDir, 'SC0RED__patch-agent', 'agency-tools'),
        ref: 'v1.0.0',
      },
    ]);
  });

  it('applies the agency-tools default path when sharedTools.path is omitted', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': 'routing: {}\n',
    });

    const parsed = agentEntrySchema.parse({
      name: 'patch',
      repo: 'git@github.com:SC0RED/patch-agent.git',
      sharedTools: {
        repo: 'git@github.com:SC0RED/agency-tools.git',
        ref: 'v1.0.0',
      },
    });

    const git = makeFakeGit();
    await loadAgents([parsed], configDir, git);

    expect(git.pinnedCalls[0]!.dir).toBe(join(configDir, 'SC0RED__patch-agent', 'agency-tools'));
  });

  it('honors a custom sharedTools.path', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': 'routing: {}\n',
    });

    const git = makeFakeGit();
    const entries: AgentEntry[] = [
      {
        name: 'patch',
        repo: 'git@github.com:SC0RED/patch-agent.git',
        sharedTools: {
          repo: 'git@github.com:SC0RED/agency-tools.git',
          ref: 'v1.0.0',
          path: 'vendor/tools',
        },
      },
    ];

    await loadAgents(entries, configDir, git);
    expect(git.pinnedCalls[0]!.dir).toBe(join(configDir, 'SC0RED__patch-agent', 'vendor/tools'));
  });

  it('clones sharedTools once when two agents in the same repo declare identical specs', async () => {
    await writeAgentRepo('SC0RED__the-agency', {
      'workspaces/patch/clawndom.yaml': 'routing: {}\n',
      'workspaces/scarlett/clawndom.yaml': 'routing: {}\n',
    });

    const git = makeFakeGit();
    const sharedTools = {
      repo: 'git@github.com:SC0RED/agency-tools.git',
      ref: 'v1.0.0',
      path: 'agency-tools',
    };
    const entries: AgentEntry[] = [
      {
        name: 'patch',
        repo: 'git@github.com:SC0RED/the-agency.git',
        path: 'workspaces/patch',
        sharedTools,
      },
      {
        name: 'scarlett',
        repo: 'git@github.com:SC0RED/the-agency.git',
        path: 'workspaces/scarlett',
        sharedTools,
      },
    ];

    await loadAgents(entries, configDir, git);
    expect(git.pinnedCalls).toHaveLength(1);
    expect(git.pinnedCalls[0]!.dir).toBe(join(configDir, 'SC0RED__the-agency', 'agency-tools'));
  });

  it('throws when two agents in the same repo declare divergent sharedTools', async () => {
    await writeAgentRepo('SC0RED__the-agency', {
      'workspaces/patch/clawndom.yaml': 'routing: {}\n',
      'workspaces/scarlett/clawndom.yaml': 'routing: {}\n',
    });

    const entries: AgentEntry[] = [
      {
        name: 'patch',
        repo: 'git@github.com:SC0RED/the-agency.git',
        path: 'workspaces/patch',
        sharedTools: {
          repo: 'git@github.com:SC0RED/agency-tools.git',
          ref: 'v1.0.0',
          path: 'agency-tools',
        },
      },
      {
        name: 'scarlett',
        repo: 'git@github.com:SC0RED/the-agency.git',
        path: 'workspaces/scarlett',
        sharedTools: {
          repo: 'git@github.com:SC0RED/agency-tools.git',
          ref: 'v2.0.0',
          path: 'agency-tools',
        },
      },
    ];

    await expect(loadAgents(entries, configDir, makeFakeGit())).rejects.toThrow(
      /Conflicting sharedTools/,
    );
  });

  it('is idempotent — re-loading produces identical pinnedCalls', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': 'routing: {}\n',
    });

    const entries: AgentEntry[] = [
      {
        name: 'patch',
        repo: 'git@github.com:SC0RED/patch-agent.git',
        sharedTools: {
          repo: 'git@github.com:SC0RED/agency-tools.git',
          ref: 'v1.0.0',
          path: 'agency-tools',
        },
      },
    ];

    const first = makeFakeGit();
    await loadAgents(entries, configDir, first);
    const second = makeFakeGit();
    await loadAgents(entries, configDir, second);

    expect(first.pinnedCalls).toEqual(second.pinnedCalls);
  });

  it('surfaces clonePinned errors (fail-fast on bad ref)', async () => {
    await writeAgentRepo('SC0RED__patch-agent', {
      'clawndom.yaml': 'routing: {}\n',
    });

    const git = makeFakeGit();
    git.failPinnedWith = new Error("fatal: unknown revision 'v9.9.9'");

    const entries: AgentEntry[] = [
      {
        name: 'patch',
        repo: 'git@github.com:SC0RED/patch-agent.git',
        sharedTools: {
          repo: 'git@github.com:SC0RED/agency-tools.git',
          ref: 'v9.9.9',
          path: 'agency-tools',
        },
      },
    ];

    await expect(loadAgents(entries, configDir, git)).rejects.toThrow(/unknown revision/);
  });
});

describe('sharedToolsSchema', () => {
  it('accepts a valid full shape', () => {
    const parsed = sharedToolsSchema.parse({
      repo: 'git@github.com:SC0RED/agency-tools.git',
      ref: 'v1.0.0',
      path: 'agency-tools',
    });
    expect(parsed).toEqual({
      repo: 'git@github.com:SC0RED/agency-tools.git',
      ref: 'v1.0.0',
      path: 'agency-tools',
    });
  });

  it("defaults path to 'agency-tools' when omitted", () => {
    const parsed = sharedToolsSchema.parse({
      repo: 'git@github.com:SC0RED/agency-tools.git',
      ref: 'v1.0.0',
    });
    expect(parsed.path).toBe('agency-tools');
  });

  it('rejects when ref is missing', () => {
    expect(() =>
      sharedToolsSchema.parse({
        repo: 'git@github.com:SC0RED/agency-tools.git',
      }),
    ).toThrow();
  });

  it('rejects when repo is missing', () => {
    expect(() =>
      sharedToolsSchema.parse({
        ref: 'v1.0.0',
      }),
    ).toThrow();
  });

  it('rejects when ref is empty', () => {
    expect(() =>
      sharedToolsSchema.parse({
        repo: 'git@github.com:SC0RED/agency-tools.git',
        ref: '',
      }),
    ).toThrow();
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
