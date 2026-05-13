import { describe, expect, it } from 'vitest';

import { auditAgent } from '../../src/audit';

import { buildAuditFixture, registerAuditFixtureHooks } from '../agent-fixture';

const makeFixture = (files: Record<string, string>): Promise<{ agentDir: string }> =>
  buildAuditFixture('dispatch-tool-test', files);

describe('checkDispatchToolPresent', () => {
  registerAuditFixtureHooks();

  it('warns when a rule declares dispatches but lacks the dispatch_task tool', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: triage
        messageTemplate: templates/triage.md
        dispatches:
          - handle-cancellation
        tools:
          - module.python: agency_tools.google.gmail_search
  internal:
    rules:
      - name: handle-cancellation
        condition:
          equals: { field: taskType, value: handle-cancellation }
        messageTemplate: templates/handle.md
        tools: []
`.trimStart(),
      'templates/triage.md': 'noop',
      'templates/handle.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'dispatch-tool-missing');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('agency_tools.clawndom.dispatch_task');
    expect(finding?.message).toContain('handle-cancellation');
  });

  it('passes when the rule lists dispatch_task on tools', async () => {
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: triage
        messageTemplate: templates/triage.md
        dispatches:
          - handle-cancellation
        tools:
          - module.python: agency_tools.google.gmail_search
          - module.python: agency_tools.clawndom.dispatch_task
  internal:
    rules:
      - name: handle-cancellation
        condition:
          equals: { field: taskType, value: handle-cancellation }
        messageTemplate: templates/handle.md
        tools: []
`.trimStart(),
      'templates/triage.md': 'noop',
      'templates/handle.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'dispatch-tool-missing');
    expect(finding).toBeUndefined();
  });

  it('does not warn on rules with empty dispatches', async () => {
    // A rule with no internal-task dispatch doesn't need the tool.
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  schedule:
    rules:
      - name: tick
        cron: '0 * * * *'
        timezone: UTC
        messageTemplate: templates/tick.md
        tools: []
`.trimStart(),
      'templates/tick.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'dispatch-tool-missing');
    expect(finding).toBeUndefined();
  });

  it('handles a missing tools field and an unnamed rule', async () => {
    // Both rule.name and rule.tools are optional in the audit schema.
    // Exercise both undefined paths in one fixture so the fall-throughs
    // (`rule.name ?? '<unnamed>'`, `tools ?? []`) are covered.
    const { agentDir } = await makeFixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - messageTemplate: templates/t.md
        dispatches:
          - handle-x
  internal:
    rules:
      - condition:
          equals: { field: taskType, value: handle-x }
        messageTemplate: templates/h.md
`.trimStart(),
      'templates/t.md': 'noop',
      'templates/h.md': 'noop',
    });
    const report = await auditAgent(agentDir);
    const finding = report.findings.find((f) => f.rule === 'dispatch-tool-missing');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('<unnamed>');
  });
});
