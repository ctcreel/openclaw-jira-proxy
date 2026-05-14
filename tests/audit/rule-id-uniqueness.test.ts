import { describe, expect, it } from 'vitest';

import { buildAgent, useAuditHarness } from '../agent-fixture';

describe('checkRuleIdUniqueness', () => {
  const harness = useAuditHarness();

  it('errors when two rules in the same provider resolve to the same default id', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          webhook: [
            { name: 'Triage Inbox', messageTemplate: 'templates/a.md', tools: [] },
            { name: 'triage-inbox', messageTemplate: 'templates/b.md', tools: [] },
          ],
        },
        templates: { 'a.md': 'noop', 'b.md': 'noop' },
      }),
    );
    const finding = report.findings.find((f) => f.rule === 'duplicate-rule-id');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('triage-inbox');
  });

  it('passes when one of the colliding rules sets an explicit id', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          webhook: [
            { name: 'Triage Inbox', messageTemplate: 'templates/a.md', tools: [] },
            {
              id: 'triage-inbox-v2',
              name: 'triage-inbox',
              messageTemplate: 'templates/b.md',
              tools: [],
            },
          ],
        },
        templates: { 'a.md': 'noop', 'b.md': 'noop' },
      }),
    );
    expect(report.findings.find((f) => f.rule === 'duplicate-rule-id')).toBeUndefined();
  });

  it('allows the same id across different providers', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          webhook: [{ name: 'triage', messageTemplate: 'templates/a.md', tools: [] }],
          internal: [
            {
              name: 'triage',
              condition: { equals: { field: 'taskType', value: 'triage' } },
              messageTemplate: 'templates/b.md',
              tools: [],
            },
          ],
        },
        templates: { 'a.md': 'noop', 'b.md': 'noop' },
      }),
    );
    expect(report.findings.find((f) => f.rule === 'duplicate-rule-id')).toBeUndefined();
  });

  it('rejects malformed explicit ids at schema-parse time', async () => {
    // Schema parse failure surfaces as a thrown error inside auditAgent
    // (the harness's audit() rejects rather than resolves).
    await expect(
      harness.audit(
        buildAgent({
          providers: {
            webhook: [
              {
                id: 'Triage_Inbox',
                name: 'triage',
                messageTemplate: 'templates/a.md',
                tools: [],
              },
            ],
          },
          templates: { 'a.md': 'noop' },
        }),
      ),
    ).rejects.toThrow(/kebab/i);
  });
});
