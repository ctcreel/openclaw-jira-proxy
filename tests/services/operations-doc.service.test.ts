import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type * as osTypes from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof osTypes>();
  return {
    ...actual,
    hostname: (): string => 'winston-agent',
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

  it('renders the tailnet hostname in identity + SSH recipe', () => {
    expect(rendered).toContain('**Host:** `winston-agent`');
    expect(rendered).toContain('SSH as `ubuntu@winston-agent`');
    expect(rendered).toContain('ssh ubuntu@winston-agent');
  });

  it('cross-references the agency-tools catalog so cold-Claude can drill into a tool', () => {
    expect(rendered).toContain(
      '[`AGENCY_TOOLS_CATALOG.md`](https://github.com/SC0RED/agency-tools/blob/main/AGENCY_TOOLS_CATALOG.md)',
    );
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

describe('renderOperationsDoc SOUL.md integration', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'opsdoc-soul-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function agentWithDir(): ResolvedAgent {
    return {
      name: 'winston',
      dir: workspaceDir,
      config: {
        routing: {},
        modelRules: {},
      } as unknown as ResolvedAgent['config'],
    };
  }

  it('includes the first SOUL.md paragraph above the deployment-facts block', () => {
    writeFileSync(
      join(workspaceDir, 'SOUL.md'),
      '# Winston\n\nI am the office manager for a speech-therapy practice. ' +
        "I read Heather's inbox, draft replies, and keep the calendar tidy.\n\n" +
        '## Voice\n\nDirect, warm, brief.\n',
    );
    const rendered = renderOperationsDoc(agentWithDir());
    expect(rendered).toContain(
      'I am the office manager for a speech-therapy practice. ' +
        "I read Heather's inbox, draft replies, and keep the calendar tidy.",
    );
    // Excerpt must sit between the marker and the deployment-facts block,
    // so cold-Claude reads "what is this agent" before "where do its logs go".
    const markerIdx = rendered.indexOf(GENERATED_MARKER);
    const excerptIdx = rendered.indexOf('I am the office manager');
    const hostIdx = rendered.indexOf('**Host:**');
    expect(markerIdx).toBeLessThan(excerptIdx);
    expect(excerptIdx).toBeLessThan(hostIdx);
  });

  it('skips the SOUL section when the file is absent', () => {
    const rendered = renderOperationsDoc(agentWithDir());
    expect(rendered).toContain('**Host:**');
    // No spurious prose between the marker and the host line.
    const markerIdx = rendered.indexOf(GENERATED_MARKER);
    const hostIdx = rendered.indexOf('**Host:**');
    const between = rendered.slice(markerIdx + GENERATED_MARKER.length, hostIdx).trim();
    expect(between).toBe('');
  });

  it('skips when SOUL.md contains only headings', () => {
    writeFileSync(join(workspaceDir, 'SOUL.md'), '# Heading-only file\n## Subheading\n');
    const rendered = renderOperationsDoc(agentWithDir());
    const markerIdx = rendered.indexOf(GENERATED_MARKER);
    const hostIdx = rendered.indexOf('**Host:**');
    const between = rendered.slice(markerIdx + GENERATED_MARKER.length, hostIdx).trim();
    expect(between).toBe('');
  });

  it('skips a fenced code block at the top of SOUL.md and takes the next paragraph', () => {
    writeFileSync(
      join(workspaceDir, 'SOUL.md'),
      '```yaml\nname: winston\n```\n\nActual purpose prose here.\n',
    );
    const rendered = renderOperationsDoc(agentWithDir());
    expect(rendered).toContain('Actual purpose prose here.');
    expect(rendered).not.toContain('```yaml');
  });

  it('truncates very long opening paragraphs at ~400 chars', () => {
    const longSentence = 'a'.repeat(600);
    writeFileSync(join(workspaceDir, 'SOUL.md'), `${longSentence}\n`);
    const rendered = renderOperationsDoc(agentWithDir());
    expect(rendered).toContain('...');
    // Total length of the rendered SOUL excerpt should be at most 400.
    const aRun = rendered.match(/a{20,}/);
    expect(aRun).not.toBeNull();
    expect(aRun !== null && aRun[0].length).toBeLessThanOrEqual(400);
  });
});
