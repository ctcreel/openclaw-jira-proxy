import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditAgent } from '../../src/audit';

interface Fixture {
  readonly agentDir: string;
}

async function buildFixture(files: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'clawndom-audit-test-'));
  for (const [relativePath, body] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, body, 'utf-8');
  }
  return { agentDir: root };
}

let fixtures: Fixture[] = [];

beforeEach(() => {
  fixtures = [];
});

afterEach(async () => {
  for (const fixture of fixtures) {
    await rm(fixture.agentDir, { recursive: true, force: true });
  }
});

async function makeFixture(files: Record<string, string>): Promise<Fixture> {
  const fixture = await buildFixture(files);
  fixtures.push(fixture);
  return fixture;
}

const MINIMAL_CONFIG = `
routing:
  test:
    rules:
      - name: smoke
        messageTemplate: templates/smoke.md
        tools: []
`.trimStart();

describe('auditAgent — happy path', () => {
  it('returns no findings when every reference resolves', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': '{{system-doc:docs/IDENTITY.md}}\nRendered body.\n',
      'docs/IDENTITY.md': 'Hello {{ name }}.\n',
    });
    const report = await auditAgent(agentDir);
    expect(report.findings).toEqual([]);
  });

  it('flags missing clawndom.yaml at the agent root', async () => {
    const { agentDir } = await makeFixture({
      'templates/smoke.md': 'orphan template',
    });
    const report = await auditAgent(agentDir);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('missing-clawndom-yaml');
  });
});

describe('checkTemplatesExist', () => {
  it('errors when a rule references a non-existent template', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  test:
    rules:
      - name: missing
        messageTemplate: templates/does-not-exist.md
`.trimStart(),
    });
    const report = await auditAgent(agentDir);
    const missing = report.findings.find((f) => f.rule === 'missing-template');
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe('error');
    expect(missing?.message).toContain('does-not-exist.md');
  });
});

describe('checkInjectionTargets', () => {
  it('errors on unresolved injections inside a template', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': '{{system-doc:docs/missing.md}}\n',
    });
    const report = await auditAgent(agentDir);
    const unresolved = report.findings.find((f) => f.rule === 'unresolved-injection');
    expect(unresolved).toBeDefined();
    expect(unresolved?.path).toBe('templates/smoke.md');
  });

  it('errors on bare-filename system-doc references at the workspace root', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': '{{system-doc:team.json}}\n',
      'team.json': '{}',
    });
    const report = await auditAgent(agentDir);
    const outside = report.findings.find((f) => f.rule === 'injection-at-workspace-root');
    expect(outside).toBeDefined();
    expect(outside?.message).toContain('team.json');
  });

  it('allows injections from any subdirectory (identity/, shared/, docs/)', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md':
        '{{system-doc:identity/IDENTITY.md}}\n{{system-doc:shared/team.json}}\n',
      'identity/IDENTITY.md': 'me',
      'shared/team.json': '{}',
    });
    const report = await auditAgent(agentDir);
    expect(report.findings).toEqual([]);
  });
});

describe('checkNoLiteralMustache', () => {
  it('catches injection-shape tokens INSIDE an injected doc (the team.json bug)', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': '{{system-doc:docs/team.json}}\n',
      'docs/team.json':
        '{\n  "_comment_": "Injected via {{system-doc:docs/team.json}} elsewhere.",\n  "x": 1\n}\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'injection-token-in-injected-doc');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('error');
    expect(finding?.path).toBe('docs/team.json');
  });

  it('catches malformed prefix tokens like {{tag-name:foo}} anywhere', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': 'See {{tag-name:foo}} — not a recognised injection prefix.\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'literal-mustache-in-doc');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('error');
  });

  it('allows real Nunjucks variable expressions with filters', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': 'Hello {{ event.ts | default("now") | replace(".","_") }}.\n',
    });
    const report = await auditAgent(agentDir);
    const literalErrors = report.findings.filter(
      (f) => f.rule === 'literal-mustache-in-doc' || f.rule === 'injection-token-in-injected-doc',
    );
    expect(literalErrors).toEqual([]);
  });
});

describe('checkToolUseDeclared', () => {
  it('errors when a template references a tool not in the route declarations', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  test:
    rules:
      - name: smoke
        messageTemplate: templates/smoke.md
        tools:
          - module.python: agency_tools.fake.tool_a
`.trimStart(),
      'templates/smoke.md': 'Emit a `tool_b` `tool_use` block to do the thing.\n',
    });
    const report = await auditAgent(agentDir);
    const undeclared = report.findings.find((f) => f.rule === 'undeclared-tool');
    expect(undeclared).toBeDefined();
    expect(undeclared?.message).toContain('tool_b');
  });

  it('accepts a tool that is declared on the route', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  test:
    rules:
      - name: smoke
        messageTemplate: templates/smoke.md
        tools:
          - module.python: agency_tools.fake.tool_a
`.trimStart(),
      'templates/smoke.md': 'Emit a `tool_a` `tool_use` block.\n',
    });
    const report = await auditAgent(agentDir);
    const undeclared = report.findings.filter((f) => f.rule === 'undeclared-tool');
    expect(undeclared).toEqual([]);
  });
});

describe('checkLegacyPatterns', () => {
  it('warns on the legacy mcp__claude_ai_ prefix', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': 'Use mcp__claude_ai_Atlassian__getJiraIssue here.\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'legacy-mcp-claude-ai-prefix');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
  });

  it('warns on legacy memory/<file>.md log-write instructions', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': 'Append a line to memory/smoke-log.md after each run.\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'legacy-memory-file-write');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
  });

  it('warns on the legacy {{system-doc:docs/TOOLS.md}} injection', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': '{{system-doc:docs/TOOLS.md}}\n',
      'docs/TOOLS.md': 'host tool inventory',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'legacy-tools-md-injection');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
  });
});
