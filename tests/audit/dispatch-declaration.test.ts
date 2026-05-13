import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditAgent } from '../../src/audit';

interface Fixture {
  readonly agentDir: string;
}

let fixtures: Fixture[] = [];

async function makeFixture(files: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'clawndom-dispatch-test-'));
  const defaults: Record<string, string> = {
    'identity/IDENTITY.md': '# T\n',
  };
  const merged = { ...defaults, ...files };
  for (const [relativePath, body] of Object.entries(merged)) {
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

describe('checkDispatchDeclaration', () => {
  it('warns when a template dispatches a task type the rule does not declare', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: triage
        messageTemplate: templates/triage.md
        tools: []
  internal:
    rules:
      - name: handle-cancellation
        condition:
          equals: { field: taskType, value: handle-cancellation }
        messageTemplate: templates/handle.md
        tools: []
`.trimStart(),
      'templates/triage.md':
        // Production templates wrap the JSON body in single quotes so the
        // "taskType" key/value appear unescaped — match that shape.
        'curl /api/tasks -d \'{ "taskType": "handle-cancellation" }\'\n',
      'templates/handle.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-dispatch');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('handle-cancellation');
  });

  it('passes when the rule declares the dispatched task type', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: triage
        messageTemplate: templates/triage.md
        dispatches:
          - handle-cancellation
        tools: []
  internal:
    rules:
      - name: handle-cancellation
        condition:
          equals: { field: taskType, value: handle-cancellation }
        messageTemplate: templates/handle.md
        tools: []
`.trimStart(),
      'templates/triage.md': 'curl /api/tasks -d "{ \\"taskType\\": \\"handle-cancellation\\" }"\n',
      'templates/handle.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-dispatch');
    expect(finding).toBeUndefined();
  });

  it('warns when a rule declares a dispatch that has no matching internal target', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: triage
        messageTemplate: templates/triage.md
        dispatches:
          - vanished-target
        tools: []
`.trimStart(),
      'templates/triage.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'dispatch-target-missing');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('vanished-target');
  });
});
