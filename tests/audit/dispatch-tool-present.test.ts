import { describe, expect, it } from 'vitest';

import { buildAgent, useAuditHarness } from '../agent-fixture';

const handleCancellationRule = {
  name: 'handle-cancellation',
  condition: { equals: { field: 'taskType', value: 'handle-cancellation' } },
  messageTemplate: 'templates/handle.md',
  tools: [],
};

const gmailSearchTool = { 'module.python': 'agency_tools.google.gmail_search' };
const dispatchTaskTool = { 'module.python': 'agency_tools.clawndom.dispatch_task' };

describe('checkDispatchToolPresent', () => {
  const harness = useAuditHarness();

  it('warns when a rule declares dispatches but lacks the dispatch_task tool', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          webhook: [
            {
              name: 'triage',
              messageTemplate: 'templates/triage.md',
              dispatches: ['handle-cancellation'],
              tools: [gmailSearchTool],
            },
          ],
          internal: [handleCancellationRule],
        },
        templates: { 'triage.md': 'noop', 'handle.md': 'noop' },
      }),
    );
    const finding = report.findings.find((f) => f.rule === 'dispatch-tool-missing');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('agency_tools.clawndom.dispatch_task');
    expect(finding?.message).toContain('handle-cancellation');
  });

  it('passes when the rule lists dispatch_task on tools', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          webhook: [
            {
              name: 'triage',
              messageTemplate: 'templates/triage.md',
              dispatches: ['handle-cancellation'],
              tools: [gmailSearchTool, dispatchTaskTool],
            },
          ],
          internal: [handleCancellationRule],
        },
        templates: { 'triage.md': 'noop', 'handle.md': 'noop' },
      }),
    );
    expect(report.findings.find((f) => f.rule === 'dispatch-tool-missing')).toBeUndefined();
  });

  it('does not warn on rules with empty dispatches', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          schedule: [
            {
              name: 'tick',
              cron: '0 * * * *',
              timezone: 'UTC',
              messageTemplate: 'templates/tick.md',
              tools: [],
            },
          ],
        },
        templates: { 'tick.md': 'noop' },
      }),
    );
    expect(report.findings.find((f) => f.rule === 'dispatch-tool-missing')).toBeUndefined();
  });

  it('handles a missing tools field and an unnamed rule', async () => {
    // Both rule.name and rule.tools are optional in the audit schema.
    // Exercise both undefined paths in one fixture so the fall-throughs
    // (`rule.name ?? '<unnamed>'`, `tools ?? []`) are covered.
    const report = await harness.audit(
      buildAgent({
        providers: {
          webhook: [{ messageTemplate: 'templates/t.md', dispatches: ['handle-x'] }],
          internal: [
            {
              condition: { equals: { field: 'taskType', value: 'handle-x' } },
              messageTemplate: 'templates/h.md',
            },
          ],
        },
        templates: { 't.md': 'noop', 'h.md': 'noop' },
      }),
    );
    const finding = report.findings.find((f) => f.rule === 'dispatch-tool-missing');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('<unnamed>');
  });
});
