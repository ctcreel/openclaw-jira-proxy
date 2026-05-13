import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findInjections,
  findSharedDir,
  resolveInjection,
  walkInjections,
} from '../../src/audit/injection-scan';

describe('findInjections', () => {
  it('returns an empty list when no injections are present', () => {
    expect(findInjections('plain prose no mustache here')).toEqual([]);
  });

  it('parses every recognised prefix on its own line', () => {
    const source = '{{doc:a.md}}\n{{system-doc:b.md}}\n{{shared:c.md}}\n{{system-shared:d.md}}\n';
    const refs = findInjections(source);
    expect(refs.map((r) => `${r.kind}:${r.target}`)).toEqual([
      'doc:a.md',
      'system-doc:b.md',
      'shared:c.md',
      'system-shared:d.md',
    ]);
    expect(refs.map((r) => r.line)).toEqual([1, 2, 3, 4]);
  });

  it('finds multiple injections on the same line', () => {
    const source = 'A {{doc:a.md}} and {{shared:b.md}} together';
    const refs = findInjections(source);
    expect(refs).toHaveLength(2);
    expect(refs[0]?.kind).toBe('doc');
    expect(refs[1]?.kind).toBe('shared');
    expect(refs[0]?.line).toBe(1);
    expect(refs[1]?.line).toBe(1);
  });

  it("tolerates whitespace around the target (mirrors the renderer's regex)", () => {
    const source = '{{system-doc:  identity/IDENTITY.md  }}';
    const refs = findInjections(source);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.target).toBe('identity/IDENTITY.md');
  });

  it('does not match Nunjucks variable expressions', () => {
    expect(findInjections('{{ event.ts | default("now") }}')).toEqual([]);
    expect(findInjections('{{ payload }}')).toEqual([]);
  });
});

describe('resolveInjection / findSharedDir / walkInjections', () => {
  let agentDir: string;
  let sharedDir: string;

  beforeEach(async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'clawndom-injection-test-'));
    agentDir = join(repoRoot, 'workspaces', 'winston');
    sharedDir = join(repoRoot, 'workspaces', 'shared');
    await mkdir(join(agentDir, 'identity'), { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(agentDir, 'identity', 'IDENTITY.md'), 'me\n');
    await writeFile(join(sharedDir, 'TOOLS.md'), 'shared inventory\n');
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
    await rm(sharedDir, { recursive: true, force: true });
  });

  it('resolves a system-doc target to the agent directory', () => {
    const res = resolveInjection(
      { kind: 'system-doc', target: 'identity/IDENTITY.md', line: 1 },
      { agentDir },
    );
    expect(res.exists).toBe(true);
    expect(res.displayPath).toBe('identity/IDENTITY.md');
  });

  it('flags a missing target as exists=false (no exception)', () => {
    const res = resolveInjection(
      { kind: 'system-doc', target: 'identity/missing.md', line: 1 },
      { agentDir },
    );
    expect(res.exists).toBe(false);
  });

  it('returns exists=false when a shared injection has no sharedDir context', () => {
    const res = resolveInjection({ kind: 'shared', target: 'TOOLS.md', line: 1 }, { agentDir });
    expect(res.exists).toBe(false);
  });

  it('resolves a shared target when sharedDir is provided', () => {
    const res = resolveInjection(
      { kind: 'system-shared', target: 'TOOLS.md', line: 1 },
      { agentDir, sharedDir },
    );
    expect(res.exists).toBe(true);
  });

  it('findSharedDir locates a sibling shared/ directory when present', () => {
    expect(findSharedDir(agentDir)).toBe(sharedDir);
  });

  it('findSharedDir returns undefined when there is no sibling shared/', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'clawndom-isolated-test-'));
    const isolatedAgent = join(isolated, 'workspaces', 'winston');
    await mkdir(isolatedAgent, { recursive: true });
    try {
      expect(findSharedDir(isolatedAgent)).toBeUndefined();
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it('walkInjections returns every reachable file (single level)', async () => {
    const reached = await walkInjections('{{system-doc:identity/IDENTITY.md}}', {
      agentDir,
    });
    expect(reached).toHaveLength(1);
    expect(reached[0]?.path).toBe('identity/IDENTITY.md');
  });

  it('walkInjections recurses into injected files and breaks cycles', async () => {
    await writeFile(
      join(agentDir, 'identity', 'IDENTITY.md'),
      '{{system-doc:identity/IDENTITY.md}}\n',
    );
    const reached = await walkInjections('{{system-doc:identity/IDENTITY.md}}', {
      agentDir,
    });
    expect(reached).toHaveLength(1);
  });
});
