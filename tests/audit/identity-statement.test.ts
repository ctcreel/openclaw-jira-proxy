import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditAgent } from '../../src/audit';
import { loadIdentityStatement } from '../../src/audit/identity-statement';

interface Fixture {
  readonly agentDir: string;
}

const MINIMAL_CONFIG = `
routing:
  test:
    rules:
      - name: smoke
        messageTemplate: templates/smoke.md
        tools: []
`.trimStart();

const VALID_FRONT_MATTER = `---
runs_as: test-agent@example.com
impersonation_subjects:
  - alice@example.com
  - bob@example.com
external_recipients: []
memory_namespaces:
  - test-personal
tool_scopes:
  - tool: gmail_search
    notes: read-only search
---

# Test Agent
Prose body.
`;

let fixtures: Fixture[] = [];

async function makeFixture(files: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'clawndom-identity-test-'));
  for (const [relativePath, body] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, body, 'utf-8');
  }
  fixtures.push({ agentDir: root });
  return { agentDir: root };
}

beforeEach(() => {
  fixtures = [];
});

afterEach(async () => {
  for (const fixture of fixtures) {
    await rm(fixture.agentDir, { recursive: true, force: true });
  }
});

describe('loadIdentityStatement', () => {
  it('parses YAML front-matter and returns the statement + prose', async () => {
    const { agentDir } = await makeFixture({
      'identity/IDENTITY.md': VALID_FRONT_MATTER,
    });
    const result = await loadIdentityStatement(join(agentDir, 'identity', 'IDENTITY.md'));
    expect(result).not.toBeNull();
    expect(result?.statement.runs_as).toBe('test-agent@example.com');
    expect(result?.statement.impersonation_subjects).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(result?.prose.trim()).toBe('# Test Agent\nProse body.');
  });

  it('returns null when IDENTITY.md has no front-matter', async () => {
    const { agentDir } = await makeFixture({
      'identity/IDENTITY.md': '# Prose-only IDENTITY\nNo front-matter.\n',
    });
    const result = await loadIdentityStatement(join(agentDir, 'identity', 'IDENTITY.md'));
    expect(result).toBeNull();
  });

  it('throws when the front-matter fails schema validation', async () => {
    const { agentDir } = await makeFixture({
      // runs_as is required by the schema.
      'identity/IDENTITY.md': '---\nimpersonation_subjects: []\n---\n# x\n',
    });
    await expect(
      loadIdentityStatement(join(agentDir, 'identity', 'IDENTITY.md')),
    ).rejects.toBeDefined();
  });
});

describe('checkIdentityStatement (via auditAgent)', () => {
  it('errors when identity/IDENTITY.md is missing entirely', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'missing-identity-statement');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('error');
  });

  it('errors when IDENTITY.md has no front-matter security statement', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': 'noop',
      'identity/IDENTITY.md': '# Prose only\nNo front-matter.\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find(
      (f) => f.rule === 'identity-statement-missing-front-matter',
    );
    expect(finding).toBeDefined();
  });

  it('errors when front-matter fails schema validation', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': 'noop',
      'identity/IDENTITY.md': '---\nimpersonation_subjects: []\n---\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'identity-statement-invalid');
    expect(finding).toBeDefined();
  });

  it('errors when a template uses a subject not declared in impersonation_subjects', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md':
        '{\n  "name": "gmail_search",\n  "input": {\n    "subject": "stranger@example.com"\n  }\n}\n',
      'identity/IDENTITY.md': VALID_FRONT_MATTER,
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-impersonation-subject');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('stranger@example.com');
  });

  it('accepts a template whose subjects are all in impersonation_subjects', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md':
        '{\n  "name": "gmail_search",\n  "input": {\n    "subject": "alice@example.com"\n  }\n}\n',
      'identity/IDENTITY.md': VALID_FRONT_MATTER,
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-impersonation-subject');
    expect(finding).toBeUndefined();
  });

  it('errors when clawndom.yaml declares a memory namespace not in memory_namespaces', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
memory:
  namespaces:
    extra-namespace:
      embeddingProvider: openai
      vectorStore: redis
routing:
  test:
    rules: []
`.trimStart(),
      'identity/IDENTITY.md': VALID_FRONT_MATTER,
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-memory-namespace');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('extra-namespace');
  });

  it('warns when IDENTITY.md lists a memory namespace clawndom.yaml does not declare', async () => {
    const front = `---
runs_as: test@example.com
memory_namespaces:
  - ghost-namespace
---
`;
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': 'noop',
      'identity/IDENTITY.md': front,
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'stale-memory-namespace');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
  });

  it('warns when a tool is declared on a route but not listed in tool_scopes', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  test:
    rules:
      - name: smoke
        messageTemplate: templates/smoke.md
        tools:
          - module.python: agency_tools.fake.unscoped_tool
`.trimStart(),
      'templates/smoke.md': 'noop',
      'identity/IDENTITY.md': VALID_FRONT_MATTER,
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-tool-scope');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('unscoped_tool');
  });

  it('ignores non-email subject placeholders like "<therapist email>"', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md':
        '{\n  "name": "gmail_search",\n  "input": {\n    "subject": "<therapist email>"\n  }\n}\n',
      'identity/IDENTITY.md': VALID_FRONT_MATTER,
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-impersonation-subject');
    expect(finding).toBeUndefined();
  });

  it('deduplicates repeated subject violations on the same template', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': MINIMAL_CONFIG,
      'templates/smoke.md': [
        '{ "subject": "stranger@example.com" }',
        '{ "subject": "stranger@example.com" }',
        '{ "subject": "stranger@example.com" }',
      ].join('\n'),
      'identity/IDENTITY.md': VALID_FRONT_MATTER,
    });
    const report = await auditAgent(agentDir);
    const findings = report.findings.filter((f) => f.rule === 'undeclared-impersonation-subject');
    expect(findings).toHaveLength(1);
  });
});
