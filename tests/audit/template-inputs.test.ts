import { describe, expect, it } from 'vitest';

import { auditAgent } from '../../src/audit';

import { buildAuditFixture, registerAuditFixtureHooks } from '../agent-fixture';

const makeFixture = (files: Record<string, string>) => buildAuditFixture('inputs-test', files);

describe('checkTemplateInputs', () => {
  registerAuditFixtureHooks();
  it('warns when a template uses a {{ var }} not declared in inputs', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  internal:
    rules:
      - name: handle
        condition:
          equals: { field: taskType, value: handle }
        messageTemplate: templates/handle.md
        inputs:
          - messageId
        tools: []
`.trimStart(),
      'templates/handle.md': 'Got {{ messageId }} from {{ from }}.\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-template-input');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('from');
  });

  it('does not warn when every referenced var is declared', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  internal:
    rules:
      - name: handle
        condition:
          equals: { field: taskType, value: handle }
        messageTemplate: templates/handle.md
        inputs:
          - messageId
          - from
        tools: []
`.trimStart(),
      'templates/handle.md': 'Got {{ messageId }} from {{ from }}.\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-template-input');
    expect(finding).toBeUndefined();
  });

  it('treats payload + Nunjucks keywords as always-available', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: r
        messageTemplate: templates/t.md
        inputs:
          - name
        tools: []
`.trimStart(),
      'templates/t.md': '{% if name %}{{ name }} ran at {{ payload }}{% endif %}\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-template-input');
    expect(finding).toBeUndefined();
  });

  it('skips checking rules with empty inputs (opt-in until migration completes)', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: r
        messageTemplate: templates/t.md
        tools: []
`.trimStart(),
      'templates/t.md': '{{ anything }}\n',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'undeclared-template-input');
    expect(finding).toBeUndefined();
  });
});
