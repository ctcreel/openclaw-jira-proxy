import { describe, expect, it } from 'vitest';

import { renderGraphFromDisk } from '../../src/graph/render';

import { buildAuditFixture, registerAuditFixtureHooks } from '../agent-fixture';

const fixture = async (files: Record<string, string>): Promise<string> => {
  const { agentDir } = await buildAuditFixture('graph-test', files);
  return agentDir;
};

describe('renderGraphFromDisk', () => {
  registerAuditFixtureHooks();
  it('emits a Mermaid flowchart wrapped in a code fence', async () => {
    const dir = await fixture({
      'clawndom.yaml': `
routing:
  schedule:
    rules:
      - name: morning
        cron: '0 6 * * *'
        timezone: America/New_York
        messageTemplate: templates/morning.md
        tools: []
`.trimStart(),
      'templates/morning.md': 'noop',
    });
    const diagram = await renderGraphFromDisk(dir, { agentName: 'sample' });
    expect(diagram).toMatch(/^```mermaid/);
    expect(diagram).toMatch(/```\n?$/);
    expect(diagram).toContain('flowchart LR');
    expect(diagram).toContain('schedule__morning');
    expect(diagram).toContain('cron 0 6 * * *');
    expect(diagram).toContain('morning.md');
  });

  it('draws a dispatch edge when a rule declares one targeting an internal rule', async () => {
    const dir = await fixture({
      'clawndom.yaml': `
routing:
  webhook:
    rules:
      - name: triage
        condition:
          equals: { field: emailAddress, value: example@x.com }
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
      'templates/triage.md': 'noop',
      'templates/handle.md': 'noop',
    });
    const diagram = await renderGraphFromDisk(dir);
    // The "==>" edge style is the dispatch arrow per renderer.
    expect(diagram).toMatch(/webhook__triage\s*==>\s*internal__handle_cancellation/);
  });

  it('renders tools as dotted edges from their rule', async () => {
    const dir = await fixture({
      'clawndom.yaml': `
routing:
  schedule:
    rules:
      - name: r
        cron: '* * * * *'
        timezone: UTC
        messageTemplate: templates/r.md
        tools:
          - module.python: agency_tools.google.gmail_send
`.trimStart(),
      'templates/r.md': 'noop',
    });
    const diagram = await renderGraphFromDisk(dir);
    expect(diagram).toContain('🔧 gmail_send');
    expect(diagram).toMatch(/schedule__r\s*-\.->\s*tool__agency_tools_google_gmail_send/);
  });

  it('falls back gracefully on irregular config shapes', async () => {
    // Exercises the defensive fall-throughs: an unknown provider (no symbol),
    // an internal rule whose condition is not `equals.taskType`, and a rule
    // with no `name` (so it falls back to a positional id).
    const dir = await fixture({
      'clawndom.yaml': `
routing:
  internal:
    rules:
      - condition:
          equals: { field: foo, value: bar }
        messageTemplate: templates/t.md
        tools: []
  custom-bus:
    rules:
      - name: passthrough
        messageTemplate: templates/t.md
        tools: []
`.trimStart(),
      'templates/t.md': 'noop',
    });
    const diagram = await renderGraphFromDisk(dir);
    // Unknown provider falls back to the 🔌 plug glyph.
    expect(diagram).toContain('🔌 custom-bus');
    // Unnamed internal rule uses positional id (rule_0).
    expect(diagram).toMatch(/internal__rule_0\["rule\[0\]"\]/);
  });
});
