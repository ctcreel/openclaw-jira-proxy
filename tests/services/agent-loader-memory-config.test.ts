import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadAgents,
  slugifyRepoUrl,
  type GitClient,
} from '../../src/services/agent-loader.service';
import type { AgentEntry } from '../../src/config';

describe('loadAgents — memory config validation', () => {
  let workspace: string;
  let configDir: string;
  let fakeRemotes: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'clawndom-memory-'));
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
      async clonePinned() {},
    };
  }

  async function writeAgentRepo(slug: string, yamlBody: string): Promise<void> {
    const repoRoot = join(fakeRemotes, slug);
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, 'clawndom.yaml'), yamlBody, 'utf-8');
  }

  const entry = (name: string, slug: string): AgentEntry => ({
    name,
    repo: `git@github.com:SC0RED/${slug}.git`,
  });

  it('parses a valid memory namespace + per-rule memory binding', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'routing:',
        '  slack-winston:',
        '    rules:',
        '      - name: chat',
        '        condition:',
        '          equals: { field: event.type, value: message }',
        '        messageTemplate: templates/chat.md',
        '        memory:',
        '          namespace: winston-personal',
        '          retrieve:',
        '            queryField: event.text',
        '            topK: 5',
        '            minSimilarity: 0.7',
        'memory:',
        '  namespaces:',
        '    winston-personal:',
        '      embeddingProvider: null-fake',
        '      vectorStore: in-memory',
        '      pruneAfter: 365d',
        '      maxStoresPerRun: 5',
        '',
      ].join('\n'),
    );
    const resolved = await loadAgents([entry('a', 'a')], configDir, makeFakeGit());
    const config = resolved[0]!.config;
    expect(Object.keys(config.memory?.namespaces ?? {})).toContain('winston-personal');
    const rule = config.routing['slack-winston']!.rules[0]!;
    expect(rule.memory?.namespace).toBe('winston-personal');
    expect(rule.memory?.retrieve?.topK).toBe(5);
  });

  it('rejects a rule referencing an undeclared namespace', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'routing:',
        '  slack-winston:',
        '    rules:',
        '      - name: chat',
        '        condition:',
        '          equals: { field: event.type, value: message }',
        '        memory:',
        '          namespace: missing-ns',
        '',
      ].join('\n'),
    );
    await expect(loadAgents([entry('a', 'a')], configDir, makeFakeGit())).rejects.toThrow(
      /undeclared memory namespace "missing-ns"/,
    );
  });

  it('rejects unknown embeddingProvider', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'memory:',
        '  namespaces:',
        '    ns:',
        '      embeddingProvider: nope',
        '      vectorStore: in-memory',
        '',
      ].join('\n'),
    );
    await expect(loadAgents([entry('a', 'a')], configDir, makeFakeGit())).rejects.toThrow(
      /unknown embeddingProvider "nope"/,
    );
  });

  it('rejects unknown vectorStore', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'memory:',
        '  namespaces:',
        '    ns:',
        '      embeddingProvider: null-fake',
        '      vectorStore: nope',
        '',
      ].join('\n'),
    );
    await expect(loadAgents([entry('a', 'a')], configDir, makeFakeGit())).rejects.toThrow(
      /unknown vectorStore "nope"/,
    );
  });

  it('rejects two agents declaring the same namespace name', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'memory:',
        '  namespaces:',
        '    shared:',
        '      embeddingProvider: null-fake',
        '      vectorStore: in-memory',
        '',
      ].join('\n'),
    );
    await writeAgentRepo(
      'SC0RED__b',
      [
        'memory:',
        '  namespaces:',
        '    shared:',
        '      embeddingProvider: null-fake',
        '      vectorStore: in-memory',
        '',
      ].join('\n'),
    );
    await expect(
      loadAgents([entry('a', 'a'), entry('b', 'b')], configDir, makeFakeGit()),
    ).rejects.toThrow(/declared by both agent "a" and agent "b"/);
  });

  it('rejects out-of-range minSimilarity', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'routing:',
        '  slack-winston:',
        '    rules:',
        '      - name: chat',
        '        condition:',
        '          equals: { field: event.type, value: message }',
        '        memory:',
        '          namespace: winston-personal',
        '          retrieve:',
        '            queryField: event.text',
        '            topK: 5',
        '            minSimilarity: 1.5',
        'memory:',
        '  namespaces:',
        '    winston-personal:',
        '      embeddingProvider: null-fake',
        '      vectorStore: in-memory',
        '',
      ].join('\n'),
    );
    await expect(loadAgents([entry('a', 'a')], configDir, makeFakeGit())).rejects.toThrow();
  });

  it('rejects malformed pruneAfter duration', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'memory:',
        '  namespaces:',
        '    ns:',
        '      embeddingProvider: null-fake',
        '      vectorStore: in-memory',
        '      pruneAfter: forever',
        '',
      ].join('\n'),
    );
    await expect(loadAgents([entry('a', 'a')], configDir, makeFakeGit())).rejects.toThrow(
      /Invalid duration/,
    );
  });

  it('agents without memory blocks parse and load unchanged', async () => {
    await writeAgentRepo(
      'SC0RED__a',
      [
        'routing:',
        '  slack-winston:',
        '    rules:',
        '      - name: chat',
        '        condition:',
        '          equals: { field: event.type, value: message }',
        '        messageTemplate: templates/chat.md',
        '',
      ].join('\n'),
    );
    const resolved = await loadAgents([entry('a', 'a')], configDir, makeFakeGit());
    expect(resolved[0]!.config.memory).toBeUndefined();
  });
});

async function copyTree(src: string, dest: string): Promise<void> {
  const { readdir, copyFile, stat } = await import('node:fs/promises');
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
