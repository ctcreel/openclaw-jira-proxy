import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAgents } from '../../src/services/agent-loader.service';
import { entry, makeFakeGit, writeAgentRepo } from '../helpers/agent-loader-fixtures';

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

  it('parses a valid memory namespace + per-rule memory binding', async () => {
    await writeAgentRepo(
      fakeRemotes,
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
    const resolved = await loadAgents([entry('a', 'a')], configDir, makeFakeGit(fakeRemotes));
    const config = resolved[0]!.config;
    expect(Object.keys(config.memory?.namespaces ?? {})).toContain('winston-personal');
    const rule = config.routing['slack-winston']!.rules[0]!;
    expect(rule.memory?.namespace).toBe('winston-personal');
    expect(rule.memory?.retrieve?.topK).toBe(5);
  });

  it('rejects a rule referencing an undeclared namespace', async () => {
    await writeAgentRepo(
      fakeRemotes,
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
    await expect(
      loadAgents([entry('a', 'a')], configDir, makeFakeGit(fakeRemotes)),
    ).rejects.toThrow(/undeclared memory namespace "missing-ns"/);
  });

  it('rejects unknown embeddingProvider', async () => {
    await writeAgentRepo(
      fakeRemotes,
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
    await expect(
      loadAgents([entry('a', 'a')], configDir, makeFakeGit(fakeRemotes)),
    ).rejects.toThrow(/unknown embeddingProvider "nope"/);
  });

  it('rejects unknown vectorStore', async () => {
    await writeAgentRepo(
      fakeRemotes,
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
    await expect(
      loadAgents([entry('a', 'a')], configDir, makeFakeGit(fakeRemotes)),
    ).rejects.toThrow(/unknown vectorStore "nope"/);
  });

  it('rejects two agents declaring the same namespace name', async () => {
    await writeAgentRepo(
      fakeRemotes,
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
      fakeRemotes,
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
      loadAgents([entry('a', 'a'), entry('b', 'b')], configDir, makeFakeGit(fakeRemotes)),
    ).rejects.toThrow(/declared by both agent "a" and agent "b"/);
  });

  it('rejects out-of-range minSimilarity', async () => {
    await writeAgentRepo(
      fakeRemotes,
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
    await expect(
      loadAgents([entry('a', 'a')], configDir, makeFakeGit(fakeRemotes)),
    ).rejects.toThrow();
  });

  it('rejects malformed pruneAfter duration', async () => {
    await writeAgentRepo(
      fakeRemotes,
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
    await expect(
      loadAgents([entry('a', 'a')], configDir, makeFakeGit(fakeRemotes)),
    ).rejects.toThrow(/Invalid duration/);
  });

  it('agents without memory blocks parse and load unchanged', async () => {
    await writeAgentRepo(
      fakeRemotes,
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
    const resolved = await loadAgents([entry('a', 'a')], configDir, makeFakeGit(fakeRemotes));
    expect(resolved[0]!.config.memory).toBeUndefined();
  });
});
