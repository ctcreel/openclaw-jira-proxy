import { describe, expect, it } from 'vitest';

import { auditAgent } from '../../src/audit';

import { buildAuditFixture, registerAuditFixtureHooks } from '../agent-fixture';

const makeFixture = (files: Record<string, string>): Promise<{ agentDir: string }> =>
  buildAuditFixture('rule-id-uniqueness', files);

describe('checkRuleIdUniqueness', () => {
  registerAuditFixtureHooks();

  it('errors when two rules in the same provider resolve to the same default id', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: Triage Inbox
        messageTemplate: templates/a.md
        tools: []
      - name: triage-inbox
        messageTemplate: templates/b.md
        tools: []
`.trimStart(),
      'templates/a.md': 'noop',
      'templates/b.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'duplicate-rule-id');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('triage-inbox');
  });

  it('passes when one of the colliding rules sets an explicit id', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: Triage Inbox
        messageTemplate: templates/a.md
        tools: []
      - id: triage-inbox-v2
        name: triage-inbox
        messageTemplate: templates/b.md
        tools: []
`.trimStart(),
      'templates/a.md': 'noop',
      'templates/b.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    expect(report.findings.find((f) => f.rule === 'duplicate-rule-id')).toBeUndefined();
  });

  it('allows the same id across different providers', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: triage
        messageTemplate: templates/a.md
        tools: []
  internal:
    rules:
      - name: triage
        condition:
          equals: { field: taskType, value: triage }
        messageTemplate: templates/b.md
        tools: []
`.trimStart(),
      'templates/a.md': 'noop',
      'templates/b.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    expect(report.findings.find((f) => f.rule === 'duplicate-rule-id')).toBeUndefined();
  });

  it('rejects malformed explicit ids at schema-parse time', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - id: Triage_Inbox
        name: triage
        messageTemplate: templates/a.md
        tools: []
`.trimStart(),
      'templates/a.md': 'noop',
    });
    // Schema parse failure surfaces as a thrown error from auditAgent;
    // we don't get a 'duplicate-rule-id' finding because parsing dies
    // before the check runs.
    await expect(auditAgent(agentDir)).rejects.toThrow(/kebab/i);
  });
});
