import { describe, it, expect, beforeEach, vi } from 'vitest';

import { GENERATED_MARKER, renderOperationsDoc } from '../../src/services/operations-doc.service';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';

vi.mock('../../src/services/version.service', () => ({
  getAgentVersion: (): {
    hash: string;
    repos: ReadonlyArray<{ name: string; sha: string; dirty: boolean }>;
  } => ({
    hash: 'sha256:abc123',
    repos: [
      { name: 'agency-tools', sha: 'b68adcf', dirty: false },
      { name: 'winston-agency', sha: 'e6e4e6f', dirty: true },
    ],
  }),
}));

vi.mock('../../src/config', async () => {
  return {
    getSettings: (): { port: number; providers: readonly never[] } => ({
      port: 8794,
      providers: [],
    }),
  };
});

interface MinimalRule {
  readonly name?: string;
  readonly id?: string;
  readonly messageTemplate?: string;
  readonly cron?: string;
  readonly timezone?: string;
  readonly tools?: ReadonlyArray<{ 'module.python': string }>;
  readonly dispatches: readonly string[];
  readonly inputs: readonly string[];
  readonly identity?: { identity: boolean; soul: boolean };
  readonly session?: { strategy: string };
  readonly memory?: { namespace?: string };
}

function rule(partial: Partial<MinimalRule> & { dispatches?: readonly string[] }): MinimalRule {
  return {
    dispatches: partial.dispatches ?? [],
    inputs: partial.inputs ?? [],
    ...partial,
  };
}

function buildAgent(routing: Record<string, { rules: readonly MinimalRule[] }>): ResolvedAgent {
  return {
    name: 'winston',
    dir: '/home/ubuntu/.clawndom-winston/agents/ctcreel__winston-agency/workspaces/winston',
    config: {
      routing,
      modelRules: {},
    } as unknown as ResolvedAgent['config'],
  };
}

describe('renderOperationsDoc', () => {
  let rendered: string;

  beforeEach(() => {
    rendered = renderOperationsDoc(
      buildAgent({
        'slack-winston': {
          rules: [
            rule({
              name: 'chat',
              messageTemplate: 'templates/slack-chat.md',
              tools: [
                { 'module.python': 'agency_tools.slack.post' },
                { 'module.python': 'agency_tools.google.gmail_send' },
              ],
              session: { strategy: 'slack' },
              memory: { namespace: 'winston-personal' },
            }),
          ],
        },
        'gmail-pubsub': {
          rules: [
            rule({
              name: 'triage-heather-inbox',
              messageTemplate: 'templates/inbox-triage.md',
              tools: [{ 'module.python': 'agency_tools.google.gmail_search' }],
              dispatches: ['draft-response', 'handle-cancellation'],
            }),
          ],
        },
        schedule: {
          rules: [
            rule({
              name: 'morning-briefing',
              cron: '0 6 * * 1-5',
              timezone: 'America/New_York',
              messageTemplate: 'templates/morning-briefing.md',
              tools: [{ 'module.python': 'agency_tools.google.gmail_send' }],
            }),
          ],
        },
      }),
    );
  });

  it('begins with the generated-by marker', () => {
    expect(rendered).toContain(GENERATED_MARKER);
  });

  it('reports the agent name in the title', () => {
    expect(rendered).toMatch(/^# Operations: winston/);
  });

  it('lists the deployment facts derived from settings', () => {
    expect(rendered).toContain('`clawndom-winston.service`');
    expect(rendered).toContain('`8794`');
    expect(rendered).toContain('/var/log/clawndom-winston/{clawndom,audit}.log');
  });

  it('embeds the agent_version hash and per-repo SHAs with dirty markers', () => {
    expect(rendered).toContain('`sha256:abc123`');
    expect(rendered).toContain('`agency-tools`');
    expect(rendered).toContain('`b68adcf`');
    expect(rendered).toContain('`winston-agency`');
    expect(rendered).toContain('⚠️ uncommitted changes');
  });

  it('groups routes by provider and skips the schedule provider in the routes section', () => {
    const routesIndex = rendered.indexOf('## Routes');
    const schedulesIndex = rendered.indexOf('## Scheduled prompts');
    const routesSection = rendered.slice(routesIndex, schedulesIndex);
    expect(routesSection).toContain('### `slack-winston`');
    expect(routesSection).toContain('### `gmail-pubsub`');
    expect(routesSection).not.toContain('### `schedule`');
  });

  it('renders the tool count, references, dispatches, session, and memory for each rule', () => {
    expect(rendered).toContain(
      'Tools (2): `agency_tools.slack.post`, `agency_tools.google.gmail_send`',
    );
    expect(rendered).toContain('Dispatches: `draft-response`, `handle-cancellation`');
    expect(rendered).toContain('Session: warm subprocess + Redis-backed resume');
    expect(rendered).toContain('Memory namespace: `winston-personal`');
  });

  it('renders the scheduled-prompts table with cron + tz + tool count', () => {
    const schedulesSection = rendered.slice(rendered.indexOf('## Scheduled prompts'));
    expect(schedulesSection).toContain('`morning-briefing`');
    expect(schedulesSection).toContain('`0 6 * * 1-5`');
    expect(schedulesSection).toContain('America/New_York');
  });

  it('includes per-agent debug recipes with the agent name substituted', () => {
    expect(rendered).toContain('clawndom-winston/clawndom.log');
    expect(rendered).toContain('clawndom-winston.service');
    expect(rendered).toContain('/home/ubuntu/.clawndom-winston/agents/');
  });

  it('ends in a single trailing newline so byte-identical re-renders are idempotent', () => {
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.endsWith('\n\n')).toBe(false);
  });

  it('renders the no-routes placeholder for an agent with no webhook providers', () => {
    const empty = renderOperationsDoc(buildAgent({}));
    expect(empty).toContain('_No webhook / event routes._');
    expect(empty).toContain('_No scheduled prompts declared in `routing.schedule`._');
  });

  it('renders the no-rules placeholder for a provider with an empty rules array', () => {
    const partial = renderOperationsDoc(
      buildAgent({
        'edge-case': { rules: [] },
      }),
    );
    expect(partial).toContain('### `edge-case`');
    expect(partial).toContain('_No rules._');
  });

  it('falls back to <unnamed> when rules lack both name and id', () => {
    const anon = renderOperationsDoc(
      buildAgent({
        'edge-case': {
          rules: [rule({})],
        },
        schedule: {
          rules: [rule({ cron: '0 0 * * *' })],
        },
      }),
    );
    expect(anon).toContain('**<unnamed>**');
    expect(anon).toContain('| `<unnamed>` |');
  });
});
