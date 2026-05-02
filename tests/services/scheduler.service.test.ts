import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures every interaction the scheduler makes through the registry +
// queue seam so each test can assert about the shape of upserts, the ids
// reconciled at the end of the pass, and the legacy-id cleanup that
// shipped alongside the Phase-2 cutover.
interface UpsertCall {
  id?: string;
  agentId: string;
  name?: string;
  when: { cron?: string; timezone?: string; fireAt?: number };
  runner: string;
  runnerConfig: unknown;
  payload?: Record<string, unknown>;
  createdBy: 'config' | 'agent';
  reason?: string;
}

const upsertCalls: UpsertCall[] = [];
const reconcileCalls: Array<readonly string[]> = [];
const removeLegacySchedulerCalls: string[] = [];

vi.mock('../../src/services/scheduled-tasks.service', () => ({
  getScheduledTasksService: (): {
    upsert: (
      input: UpsertCall,
    ) => Promise<UpsertCall & { id: string; runCount: number; createdAt: number }>;
    reconcileConfig: (loadedIds: ReadonlySet<string>) => Promise<readonly string[]>;
  } => ({
    upsert: async (
      input: UpsertCall,
    ): Promise<UpsertCall & { id: string; runCount: number; createdAt: number }> => {
      upsertCalls.push(input);
      return {
        ...input,
        id: input.id ?? 'generated-id',
        runCount: 0,
        createdAt: 0,
      };
    },
    reconcileConfig: async (loadedIds: ReadonlySet<string>): Promise<readonly string[]> => {
      reconcileCalls.push([...loadedIds]);
      return [];
    },
  }),
}));

vi.mock('../../src/services/task.service', () => ({
  getTaskQueue: (): { removeJobScheduler: (id: string) => Promise<boolean> } => ({
    removeJobScheduler: async (id: string): Promise<boolean> => {
      removeLegacySchedulerCalls.push(id);
      return false;
    },
  }),
  resetTaskQueues: (): void => {},
}));

import { registerAgentSchedules } from '../../src/services/scheduler.service';
import { deriveConfigTaskId } from '../../src/types/scheduled-task';
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
    reconcileCalls.length = 0;
    removeLegacySchedulerCalls.length = 0;
  });

  it('returns empty array when no agent declares schedule rules', async () => {
    const agents: ResolvedAgent[] = [
      { name: 'patch', dir: '/agents/patch', config: { routing: {}, modelRules: {} } },
    ];
    const result = await registerAgentSchedules(agents);
    expect(result).toEqual([]);
    expect(upsertCalls).toHaveLength(0);
    // Reconcile still runs at the end of the pass, even with zero rules,
    // so config-removed orphans get deleted on a "removed every rule"
    // boot. Set is empty when no rules survived.
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]).toEqual([]);
  });

  it('upserts one registry record per declared rule', async () => {
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
    });

    expect(upsertCalls).toHaveLength(1);
    const upsert = upsertCalls[0]!;
    expect(upsert).toMatchObject({
      agentId: 'scarlett',
      name: 'daily-handoff',
      when: { cron: '45 7 * * 1-5', timezone: 'America/New_York' },
      runner: 'claude-cli',
      runnerConfig: { type: 'claude-cli', workDirectory: '/agents/scarlett' },
      createdBy: 'config',
      reason: 'config-load',
      payload: {},
    });
  });

  it('derives a stable content-hash id so identical rules get identical ids', async () => {
    const buildSameAgent = (): ResolvedAgent =>
      buildAgent('scarlett', [
        {
          name: 'daily-handoff',
          cron: '45 7 * * 1-5',
          timezone: 'America/New_York',
          messageTemplate: 'templates/daily-handoff.md',
          catchUp: false,
        },
      ]);

    await registerAgentSchedules([buildSameAgent()]);
    const firstId = upsertCalls[0]!.id;
    upsertCalls.length = 0;
    reconcileCalls.length = 0;

    await registerAgentSchedules([buildSameAgent()]);
    const secondId = upsertCalls[0]!.id;

    expect(firstId).toBeDefined();
    expect(secondId).toBe(firstId);

    // Independent computation against deriveConfigTaskId proves the
    // scheduler is using the documented derivation, not a private hash
    // that happens to be stable.
    const expectedId = deriveConfigTaskId({
      agentId: 'scarlett',
      name: 'daily-handoff',
      when: { cron: '45 7 * * 1-5', timezone: 'America/New_York' },
      runner: 'claude-cli',
      runnerConfig: { type: 'claude-cli', workDirectory: '/agents/scarlett' },
    });
    expect(firstId).toBe(expectedId);
  });

  it('omits timezone from when when no timezone declared', async () => {
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

    expect(upsertCalls[0]!.when).toEqual({ cron: '0 * * * *' });
    expect('timezone' in upsertCalls[0]!.when).toBe(false);
  });

  it('forwards rule.context as the registry payload', async () => {
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

    expect(upsertCalls[0]!.payload).toEqual({ recipient: 'heather@talkatlanta.info' });
  });

  it('forwards an explicit per-rule runner block to the registry', async () => {
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

    await registerAgentSchedules(agents);

    expect(upsertCalls[0]!.runner).toBe('shell');
    expect(upsertCalls[0]!.runnerConfig).toMatchObject({
      type: 'shell',
      command: 'python3 ./tools/refresh.py',
      timeoutMs: 60_000,
    });
  });

  it('strips the legacy schedule:<agent>:<rule> id before upserting', async () => {
    const agents = [
      buildAgent('scarlett', [
        {
          name: 'daily-handoff',
          cron: '45 7 * * 1-5',
          messageTemplate: 'templates/daily-handoff.md',
          catchUp: false,
        },
      ]),
    ];

    await registerAgentSchedules(agents);

    // Pre-Phase-2 deploys keyed schedulers under this prefix; cleaning
    // them on every boot prevents a rolling-deploy double-fire.
    expect(removeLegacySchedulerCalls).toContain('schedule:scarlett:daily-handoff');
  });

  it('runs config reconcile with the full set of registered ids', async () => {
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
    expect(reconcileCalls).toHaveLength(1);
    const reconciledIds = reconcileCalls[0]!;
    // The reconcile set is exactly the ids we just registered — proves
    // a removed-since-last-boot rule wouldn't be in the set and would
    // therefore get cleaned up by the registry.
    const localeCompare = (a: string, b: string): number => a.localeCompare(b);
    expect([...reconciledIds].sort(localeCompare)).toEqual(
      [...result.map((r) => r.taskId)].sort(localeCompare),
    );
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
    expect(upsertCalls[0]!.runner).toBe('shell');
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
});
