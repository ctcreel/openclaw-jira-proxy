import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertCalls: Array<{
  schedulerId: string;
  repeatOpts: { pattern: string; tz?: string };
  template: { name: string; data: string };
}> = [];

vi.mock('bullmq', () => {
  class QueueMock {
    async upsertJobScheduler(
      schedulerId: string,
      repeatOpts: { pattern: string; tz?: string },
      template: { name: string; data: string; opts?: unknown },
    ) {
      upsertCalls.push({
        schedulerId,
        repeatOpts,
        template: { name: template.name, data: template.data },
      });
    }
    async close() {
      return undefined;
    }
  }
  return {
    Queue: QueueMock,
    QueueEvents: class {
      async close() {
        return undefined;
      }
    },
  };
});

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { registerAgentSchedules } from '../../src/services/scheduler.service';
import { resetTaskQueues } from '../../src/services/task.service';
import type { AgentRule, ResolvedAgent } from '../../src/services/agent-loader.service';

// Test rules cover both well-formed schedule rules and intentionally
// malformed ones (missing name, missing cron, etc.) for error-path
// coverage. Typing as readonly Partial<AgentRule>[] lets each test
// construct only the fields it cares about; the runtime is the source
// of truth for required-field validation.
type TestRule = Partial<AgentRule> & { name?: string; cron?: string };

function buildAgent(name: string, scheduleRules: readonly TestRule[]): ResolvedAgent {
  // The agentRoutingSchema parser fills in defaults (catchUp: false) at
  // load time. In tests we hand-construct without parsing, so we cast
  // through `unknown` to satisfy the AgentRule[] typing — the test is
  // exercising the function's behaviour given various rule shapes,
  // not the schema parser.
  const rules = scheduleRules as unknown as readonly AgentRule[];
  return {
    name,
    dir: `/agents/${name}`,
    config: {
      routing: { schedule: { rules } },
      modelRules: {},
    },
  };
}

describe('registerAgentSchedules', () => {
  beforeEach(() => {
    upsertCalls.length = 0;
    resetTaskQueues();
  });

  it('returns empty array when no agent declares schedule rules', async () => {
    const agents: ResolvedAgent[] = [
      { name: 'patch', dir: '/agents/patch', config: { routing: {}, modelRules: {} } },
    ];
    const result = await registerAgentSchedules(agents);
    expect(result).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
  });

  it('registers one BullMQ scheduler per declared rule', async () => {
    const agents = [
      buildAgent('scarlett', [
        {
          name: 'daily-handoff',
          cron: '45 7 * * 1-5',
          timezone: 'America/New_York',
          messageTemplate: 'templates/daily-handoff.md',
          catchUp: false,
        },
      ]),
    ];

    const result = await registerAgentSchedules(agents);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      agent: 'scarlett',
      rule: 'daily-handoff',
      cron: '45 7 * * 1-5',
      timezone: 'America/New_York',
      schedulerId: 'schedule:scarlett:daily-handoff',
    });

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.schedulerId).toBe('schedule:scarlett:daily-handoff');
    expect(upsertCalls[0]!.repeatOpts).toEqual({
      pattern: '45 7 * * 1-5',
      tz: 'America/New_York',
    });
    expect(upsertCalls[0]!.template.name).toBe('daily-handoff');
    const data = JSON.parse(upsertCalls[0]!.template.data);
    expect(data).toMatchObject({
      kind: 'scheduled',
      rule: 'daily-handoff',
      context: {},
    });
  });

  it('omits tz from repeat options when no timezone declared', async () => {
    const agents = [
      buildAgent('patch', [
        {
          name: 'hourly-check',
          cron: '0 * * * *',
          messageTemplate: 'templates/hourly.md',
          catchUp: false,
        },
      ]),
    ];

    await registerAgentSchedules(agents);

    expect(upsertCalls[0]!.repeatOpts).toEqual({ pattern: '0 * * * *' });
    expect('tz' in upsertCalls[0]!.repeatOpts).toBe(false);
  });

  it('passes static rule.context through to the scheduled job data', async () => {
    const agents = [
      buildAgent('winston', [
        {
          name: 'morning-briefing',
          cron: '0 6 * * 1-5',
          timezone: 'America/New_York',
          messageTemplate: 'templates/morning-briefing.md',
          context: { recipient: 'heather@talkatlanta.info' },
          catchUp: false,
        },
      ]),
    ];

    await registerAgentSchedules(agents);

    const data = JSON.parse(upsertCalls[0]!.template.data);
    expect(data.context).toEqual({ recipient: 'heather@talkatlanta.info' });
  });

  it('throws when a schedule rule lacks a name', async () => {
    const agents = [
      buildAgent('scarlett', [
        {
          cron: '0 9 * * *',
          messageTemplate: 'templates/foo.md',
          catchUp: false,
        },
      ]),
    ];

    await expect(registerAgentSchedules(agents)).rejects.toThrow(/without a "name" field/);
  });

  it('throws when a schedule rule lacks a cron expression', async () => {
    const agents = [
      buildAgent('scarlett', [
        {
          name: 'no-cron',
          messageTemplate: 'templates/foo.md',
          catchUp: false,
        },
      ]),
    ];

    await expect(registerAgentSchedules(agents)).rejects.toThrow(/missing a "cron" field/);
  });

  it('throws when a schedule rule lacks a messageTemplate', async () => {
    const agents = [
      buildAgent('scarlett', [
        {
          name: 'no-template',
          cron: '0 9 * * *',
          catchUp: false,
        },
      ]),
    ];

    await expect(registerAgentSchedules(agents)).rejects.toThrow(
      /missing a "messageTemplate" field/,
    );
  });

  it('does not require messageTemplate for shell-runner schedule rules', async () => {
    const agents = [
      buildAgent('winston', [
        {
          name: 'gmail-watch-refresh',
          cron: '0 9 * * 1',
          catchUp: false,
          runner: { type: 'shell', command: 'python3 ./tools/refresh.py', timeoutMs: 60_000 },
        },
      ]),
    ];

    const result = await registerAgentSchedules(agents);
    expect(result).toHaveLength(1);
    expect(upsertCalls[0]!.schedulerId).toBe('schedule:winston:gmail-watch-refresh');
  });

  it('still requires messageTemplate when a non-shell runner override is specified', async () => {
    const agents = [
      buildAgent('scarlett', [
        {
          name: 'override-claude',
          cron: '0 9 * * *',
          catchUp: false,
          runner: { type: 'claude-cli', workDirectory: '/tmp/x' },
        },
      ]),
    ];

    await expect(registerAgentSchedules(agents)).rejects.toThrow(
      /missing a "messageTemplate" field/,
    );
  });

  it('registers schedules for multiple agents in one pass', async () => {
    const agents = [
      buildAgent('scarlett', [
        { name: 'daily-handoff', cron: '45 7 * * 1-5', messageTemplate: 't.md', catchUp: false },
      ]),
      buildAgent('winston', [
        { name: 'morning-briefing', cron: '0 6 * * 1-5', messageTemplate: 'm.md', catchUp: false },
        { name: 'evening-audit', cron: '0 21 * * *', messageTemplate: 'e.md', catchUp: false },
      ]),
    ];

    const result = await registerAgentSchedules(agents);

    expect(result).toHaveLength(3);
    expect(result.map((r) => r.schedulerId)).toEqual([
      'schedule:scarlett:daily-handoff',
      'schedule:winston:morning-briefing',
      'schedule:winston:evening-audit',
    ]);
  });
});
