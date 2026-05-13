import { describe, expect, it } from 'vitest';

import { useAuditHarness } from '../agent-fixture';

describe('checkDispatchDeclaration', () => {
  const harness = useAuditHarness();

  it('warns when a template dispatches a task type the rule does not declare', async () => {
    const report = await harness.audit({
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
      // Production templates wrap the JSON body in single quotes so the
      // "taskType" key/value appear unescaped — match that shape.
      'templates/triage.md': 'curl /api/tasks -d \'{ "taskType": "handle-cancellation" }\'\n',
      'templates/handle.md': 'noop',
    });
    const finding = report.findings.find((f) => f.rule === 'undeclared-dispatch');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('handle-cancellation');
  });

  it('passes when the rule declares the dispatched task type', async () => {
    const report = await harness.audit({
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
    expect(report.findings.find((f) => f.rule === 'undeclared-dispatch')).toBeUndefined();
  });

  it('warns when a rule declares a dispatch that has no matching internal target', async () => {
    const report = await harness.audit({
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
    const finding = report.findings.find((f) => f.rule === 'dispatch-target-missing');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('vanished-target');
  });
});
