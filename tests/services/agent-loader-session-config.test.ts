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

describe('loadAgents — session config validation', () => {
  let workspace: string;
  let configDir: string;
  let fakeRemotes: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'clawndom-session-'));
    configDir = join(workspace, 'config');
    fakeRemotes = join(workspace, 'remotes');
    await mkdir(fakeRemotes, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function makeFakeGit(): GitClient {
    return {
      async cloneOrPull(repoUrl: string, cloneDir: string) {
        const source = join(fakeRemotes, slugifyRepoUrl(repoUrl));
        await mkdir(cloneDir, { recursive: true });
        await copyTree(source, cloneDir);
      },
      async clonePinned() {
        // not used in these tests
      },
    };
  }

  async function writeAgentRepo(slug: string, yamlBody: string): Promise<void> {
    const repoRoot = join(fakeRemotes, slug);
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, 'clawndom.yaml'), yamlBody, 'utf-8');
  }

  const entries: AgentEntry[] = [{ name: 'a', repo: 'git@github.com:SC0RED/a.git' }];

  it('accepts a routing rule with a valid session block', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'routing:',
        '  slack-winston:',
        '    rules:',
        '      - name: chat',
        '        condition:',
        '          equals:',
        '            field: event.type',
        '            value: message',
        '        messageTemplate: templates/chat.md',
        '        session:',
        '          strategy: slack',
        '          ttl: 7d',
        '          idleTimeout: 30m',
        '',
      ].join('\n'),
    );
    const resolved = await loadAgents(entries, configDir, makeFakeGit());
    const rule = resolved[0]!.config.routing['slack-winston']!.rules[0]!;
    expect(rule.session?.strategy).toBe('slack');
    expect(rule.session?.ttl).toBe(7 * 24 * 60 * 60 * 1000);
    expect(rule.session?.idleTimeout).toBe(30 * 60 * 1000);
  });

  it('rejects a session block on a routing.schedule rule', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'routing:',
        '  schedule:',
        '    rules:',
        '      - name: morning-briefing',
        '        cron: "0 6 * * 1-5"',
        '        timezone: America/New_York',
        '        messageTemplate: templates/briefing.md',
        '        session:',
        '          strategy: slack',
        '          ttl: 7d',
        '          idleTimeout: 30m',
        '',
      ].join('\n'),
    );
    await expect(loadAgents(entries, configDir, makeFakeGit())).rejects.toThrow(
      /schedule rule .+ declares session/,
    );
  });

  it('rejects an unknown session.strategy', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'routing:',
        '  slack-winston:',
        '    rules:',
        '      - name: chat',
        '        condition:',
        '          equals:',
        '            field: event.type',
        '            value: message',
        '        messageTemplate: templates/chat.md',
        '        session:',
        '          strategy: nonexistent',
        '          ttl: 7d',
        '          idleTimeout: 30m',
        '',
      ].join('\n'),
    );
    await expect(loadAgents(entries, configDir, makeFakeGit())).rejects.toThrow(
      /unknown session\.strategy "nonexistent"/,
    );
  });

  it('rejects an invalid duration', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'routing:',
        '  slack-winston:',
        '    rules:',
        '      - name: chat',
        '        condition:',
        '          equals:',
        '            field: event.type',
        '            value: message',
        '        messageTemplate: templates/chat.md',
        '        session:',
        '          strategy: slack',
        '          ttl: forever',
        '          idleTimeout: 30m',
        '',
      ].join('\n'),
    );
    await expect(loadAgents(entries, configDir, makeFakeGit())).rejects.toThrow(/Invalid duration/);
  });

  it('rules without a session block parse and load unchanged', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'routing:',
        '  slack-winston:',
        '    rules:',
        '      - name: chat',
        '        condition:',
        '          equals:',
        '            field: event.type',
        '            value: message',
        '        messageTemplate: templates/chat.md',
        '',
      ].join('\n'),
    );
    const resolved = await loadAgents(entries, configDir, makeFakeGit());
    const rule = resolved[0]!.config.routing['slack-winston']!.rules[0]!;
    expect(rule.session).toBeUndefined();
  });
});

async function copyTree(src: string, dest: string): Promise<void> {
  const { readdir, copyFile } = await import('node:fs/promises');
  const { stat } = await import('node:fs/promises');
  const entries = await readdir(src);
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const s = join(src, entry);
    const d = join(dest, entry);
    const info = await stat(s);
    if (info.isDirectory()) {
      await copyTree(s, d);
    } else {
      await copyFile(s, d);
    }
  }
}
