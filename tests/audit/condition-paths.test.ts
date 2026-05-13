import { describe, expect, it } from 'vitest';

import { buildAgent, useAuditHarness } from '../agent-fixture';

describe('checkConditionPaths', () => {
  const harness = useAuditHarness();

  it('warns on a typo in a jira condition field path', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          jira: [
            {
              name: 'triage',
              condition: { equals: { field: 'issue.field.summary', value: 'hi' } },
              messageTemplate: 'templates/t.md',
              tools: [],
            },
          ],
        },
        templates: { 't.md': 'noop' },
      }),
    );
    const finding = report.findings.find((f) => f.rule === 'condition-path-unknown');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('issue.field.summary');
  });

  it('passes when every condition path resolves in the provider schema', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          jira: [
            {
              name: 'plan-bug',
              condition: {
                all_of: [
                  { equals: { field: 'webhookEvent', value: 'jira:issue_updated' } },
                  { equals: { field: 'issue.fields.issuetype.name', value: 'Bug' } },
                  {
                    any_item: {
                      path: 'changelog.items',
                      where: {
                        all_of: [
                          { equals: { field: 'field', value: 'status' } },
                          { equals: { field: 'toString', value: 'Plan' } },
                        ],
                      },
                    },
                  },
                ],
              },
              messageTemplate: 'templates/t.md',
              tools: [],
            },
          ],
        },
        templates: { 't.md': 'noop' },
      }),
    );
    expect(report.findings.find((f) => f.rule === 'condition-path-unknown')).toBeUndefined();
  });

  it('descends array item schemas inside any_item.where', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          jira: [
            {
              name: 'bad-item-field',
              condition: {
                any_item: {
                  path: 'changelog.items',
                  where: { equals: { field: 'notARealField', value: 'x' } },
                },
              },
              messageTemplate: 'templates/t.md',
              tools: [],
            },
          ],
        },
        templates: { 't.md': 'noop' },
      }),
    );
    const finding = report.findings.find((f) => f.rule === 'condition-path-unknown');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('notARealField');
  });

  it('does not warn for providers with no registered payload schema', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          zapier: [
            {
              name: 'catchall',
              condition: { equals: { field: 'anything.goes', value: 'x' } },
              messageTemplate: 'templates/t.md',
              tools: [],
            },
          ],
        },
        templates: { 't.md': 'noop' },
      }),
    );
    expect(report.findings.find((f) => f.rule === 'condition-path-unknown')).toBeUndefined();
  });

  it('accepts paths into the slack event subtree for slack-named providers', async () => {
    const report = await harness.audit(
      buildAgent({
        providers: {
          'slack-winston': [
            {
              name: 'chat',
              condition: {
                all_of: [
                  { equals: { field: 'event.type', value: 'app_mention' } },
                  { exists: { field: 'event.bot_id' } },
                ],
              },
              messageTemplate: 'templates/t.md',
              tools: [],
            },
          ],
        },
        templates: { 't.md': 'noop' },
      }),
    );
    expect(report.findings.find((f) => f.rule === 'condition-path-unknown')).toBeUndefined();
  });
});
