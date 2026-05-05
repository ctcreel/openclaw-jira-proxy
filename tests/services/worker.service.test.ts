import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';

import type { ProviderConfig, ModelRule } from '../../src/config';
import type { AgentConfig, ResolvedAgent } from '../../src/services/agent-loader.service';
import type { Condition } from '../../src/strategies/routing';

// SPE-2002: route through the shared validating BullMQ mock so any future
// `new Worker('bad:name', ...)` introduced via this test path crashes at
// construction time instead of silently passing CI.
vi.mock('bullmq', async () => {
  const helper = await import('../helpers/bullmq-mock');
  return helper.bullmqMockModule;
});

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/lib/template/template-engine', () => ({
  renderTemplate: vi.fn().mockResolvedValue({ systemPrompt: '', body: 'rendered-template-output' }),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('file-template-content'),
}));

const { loggerInfoSpy, loggerDebugSpy, loggerWarnSpy, loggerErrorSpy } = vi.hoisted(() => ({
  loggerInfoSpy: vi.fn(),
  loggerDebugSpy: vi.fn(),
  loggerWarnSpy: vi.fn(),
  loggerErrorSpy: vi.fn(),
}));

vi.mock('../../src/lib/logging', () => ({
  getLogger: (): Record<string, ReturnType<typeof vi.fn>> => ({
    info: loggerInfoSpy,
    debug: loggerDebugSpy,
    warn: loggerWarnSpy,
    error: loggerErrorSpy,
  }),
  setupLogging: vi.fn(),
  resetLogging: vi.fn(),
}));

import {
  processJob,
  parseEnvelope,
  resolveModel,
  buildEnvVarNameForSecret,
  resolveEnvSecrets,
} from '../../src/services/worker.service';
import type { JobEnvelope } from '../../src/services/worker.service';
import { resetSettings } from '../../src/config';
import { renderTemplate } from '../../src/lib/template/template-engine';
import { readFile } from 'node:fs/promises';
import { registerRunner, resetRunners } from '../../src/runners/registry';
import type { AgentRunner, RunOptions, RunResult } from '../../src/runners/types';
import type { SecretManager } from '../../src/secrets/manager';
import { buildMockSecretManager } from '../helpers/mock-secret-manager';

const runSpy = vi.fn<[RunOptions], Promise<RunResult>>().mockResolvedValue({
  status: 'ok',
  runId: 'mock-run-id',
  renderedPrompt: 'mock-prompt',
});

class SpyRunner implements AgentRunner {
  readonly name = 'openclaw';
  async run(options: RunOptions): Promise<RunResult> {
    return runSpy(options);
  }
}

const testProvider: ProviderConfig = {
  name: 'test-provider',
  transport: 'webhook',
  routePath: '/hooks/test',
  hmacSecret: 'test-hmac-secret',
  signatureStrategy: 'websub',
  openclawHookUrl: 'http://127.0.0.1:18789/hooks/test',
};

interface AgentShape {
  rules?: Array<{ condition: Condition; messageTemplate?: string; name?: string }>;
  modelRules?: ModelRule[];
}

function buildAgent(
  name: string,
  providerName: string,
  shape: AgentShape,
  dir = `/agents/${name}`,
): ResolvedAgent {
  const config: AgentConfig = {
    routing: shape.rules ? { [providerName]: { rules: shape.rules } } : {},
    modelRules: shape.modelRules ? { [providerName]: shape.modelRules } : {},
  };
  return { name, dir, config };
}

function createFakeJob(data: string, id = 'test-job-1'): Job<string> {
  return { id, data } as unknown as Job<string>;
}

describe('processJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runSpy.mockResolvedValue({
      status: 'ok',
      runId: 'mock-run-id',
      renderedPrompt: 'mock-prompt',
    });
    resetSettings();
    resetRunners();
    registerRunner(new SpyRunner());
  });

  it('returns early with no agents when nothing routes', async () => {
    await processJob(createFakeJob('{"event":"updated"}'), testProvider, []);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('routes to the first agent whose rule matches', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [
          {
            condition: {
              equals: { field: 'issue.fields.assignee.displayName', value: 'Patches' },
            },
          },
        ],
      }),
    ];

    await processJob(
      createFakeJob('{"issue":{"fields":{"assignee":{"displayName":"Patches"}}}}'),
      testProvider,
      agents,
    );

    expect(runSpy).toHaveBeenCalledOnce();
    expect(runSpy.mock.calls[0]![0].agentId).toBe('patch');
    expect(runSpy.mock.calls[0]![0].prompt).toBe(
      '{"issue":{"fields":{"assignee":{"displayName":"Patches"}}}}',
    );
  });

  it('walks agents in config order — first agent with a matching rule wins', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [
          {
            condition: {
              equals: { field: 'issue.fields.assignee.displayName', value: 'Patches' },
            },
          },
        ],
      }),
      buildAgent('main', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];

    await processJob(
      createFakeJob('{"issue":{"fields":{"assignee":{"displayName":"Someone Else"}}}}'),
      testProvider,
      agents,
    );

    expect(runSpy.mock.calls[0]![0].agentId).toBe('main');
  });

  it('skips forwarding when no agent rule matches', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [
          {
            condition: {
              equals: { field: 'issue.fields.assignee.displayName', value: 'Nobody' },
            },
          },
        ],
      }),
    ];

    await processJob(createFakeJob('{"issue":{"fields":{}}}'), testProvider, agents);

    expect(runSpy).not.toHaveBeenCalled();
  });

  it('throws when runner returns error status', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];

    runSpy.mockResolvedValueOnce({
      status: 'error',
      error: 'Agent crashed',
      renderedPrompt: 'test',
    });

    await expect(processJob(createFakeJob('{}'), testProvider, agents)).rejects.toThrow(
      'Agent run failed: Agent crashed',
    );
  });

  it('throws when runner returns timeout status', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];

    runSpy.mockResolvedValueOnce({
      status: 'timeout',
      runId: 'timeout-run',
      renderedPrompt: 'test',
    });

    await expect(processJob(createFakeJob('{}'), testProvider, agents)).rejects.toThrow(
      'Agent run timed out (runId: timeout-run)',
    );
  });

  it('uses originalJobId in session key for re-enqueued jobs', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];

    const envelope: JobEnvelope = {
      payload: '{"issue":{"key":"SPE-1234"}}',
      attempt: 2,
      originalJobId: 'original-42',
    };

    await processJob(createFakeJob(JSON.stringify(envelope)), testProvider, agents);

    expect(runSpy.mock.calls[0]![0].sessionKey).toContain('original-42');
  });

  it('passes agentWaitTimeoutMs to runner', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];

    await processJob(createFakeJob('{"event":"test"}'), testProvider, agents);

    expect(runSpy.mock.calls[0]![0].timeoutMs).toBe(1_800_000);
  });

  it('uses provider runner type when configured', async () => {
    const customRunSpy = vi.fn<[RunOptions], Promise<RunResult>>().mockResolvedValue({
      status: 'ok',
      runId: 'custom-run',
      renderedPrompt: 'test',
    });

    class CustomRunner implements AgentRunner {
      readonly name = 'openai';
      async run(options: RunOptions): Promise<RunResult> {
        return customRunSpy(options);
      }
    }

    registerRunner(new CustomRunner());

    const providerWithRunner: ProviderConfig = {
      ...testProvider,
      runner: { type: 'openai', model: 'gpt-4o', apiKey: 'test-key' },
    };

    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];

    await processJob(createFakeJob('{"event":"test"}'), providerWithRunner, agents);

    expect(customRunSpy).toHaveBeenCalledOnce();
  });
});

describe('parseEnvelope', () => {
  it('wraps raw string as first attempt', () => {
    const result = parseEnvelope('{"event":"updated"}');
    expect(result).toEqual({ payload: '{"event":"updated"}', attempt: 1 });
  });

  it('returns existing envelope as-is', () => {
    const envelope: JobEnvelope = {
      payload: '{"event":"updated"}',
      attempt: 2,
      originalJobId: 'job-42',
    };
    const result = parseEnvelope(JSON.stringify(envelope));
    expect(result).toEqual(envelope);
  });

  it('treats non-envelope JSON as raw payload', () => {
    const result = parseEnvelope('{"issue":{"key":"SPE-1"}}');
    expect(result.payload).toBe('{"issue":{"key":"SPE-1"}}');
    expect(result.attempt).toBe(1);
  });

  it('handles malformed JSON as raw payload', () => {
    const result = parseEnvelope('not-json');
    expect(result.payload).toBe('not-json');
    expect(result.attempt).toBe(1);
  });

  it('preserves context when present on the envelope', () => {
    const envelope: JobEnvelope = {
      payload: '{"issue":{"key":"SPE-1"}}',
      attempt: 1,
      context: { id: 'SPE-1', title: 'Bug title', status: 'Plan' },
    };
    const result = parseEnvelope(JSON.stringify(envelope));
    expect(result.context).toEqual({ id: 'SPE-1', title: 'Bug title', status: 'Plan' });
  });
});

describe('resolveModel', () => {
  const statusRules: ModelRule[] = [
    {
      field: 'issue.fields.status.name',
      matches: ['Plan', 'Ready for Development'],
      model: 'anthropic/claude-opus-4-7',
    },
    {
      field: 'issue.fields.status.name',
      matches: ['Done', 'In Progress', 'To Do'],
      model: 'anthropic/claude-sonnet-4-6',
    },
  ];

  it('returns matching model for single string match', () => {
    const payload = { issue: { fields: { status: { name: 'Plan' } } } };
    expect(resolveModel(payload, statusRules)).toBe('anthropic/claude-opus-4-7');
  });

  it('returns matching model for array match', () => {
    const payload = { issue: { fields: { status: { name: 'Ready for Development' } } } };
    expect(resolveModel(payload, statusRules)).toBe('anthropic/claude-opus-4-7');
  });

  it('returns second rule when first does not match', () => {
    const payload = { issue: { fields: { status: { name: 'Done' } } } };
    expect(resolveModel(payload, statusRules)).toBe('anthropic/claude-sonnet-4-6');
  });

  it('returns undefined when no rules match', () => {
    const payload = { issue: { fields: { status: { name: 'Unknown' } } } };
    expect(resolveModel(payload, statusRules)).toBeUndefined();
  });

  it('returns undefined when rules are undefined', () => {
    expect(resolveModel({ foo: 'bar' }, undefined)).toBeUndefined();
  });

  it('returns undefined when rules are empty', () => {
    expect(resolveModel({ foo: 'bar' }, [])).toBeUndefined();
  });

  it('returns undefined when field path does not exist', () => {
    const rules: ModelRule[] = [
      { field: 'deeply.nested.missing', matches: 'value', model: 'opus' },
    ];
    expect(resolveModel({}, rules)).toBeUndefined();
  });

  it('matches when field value is an array containing a match', () => {
    const rules: ModelRule[] = [{ field: 'tags', matches: 'urgent', model: 'opus' }];
    expect(resolveModel({ tags: ['urgent', 'bug'] }, rules)).toBe('opus');
  });

  it('returns first matching rule (priority order)', () => {
    const rules: ModelRule[] = [
      { field: 'type', matches: 'critical', model: 'opus' },
      { field: 'type', matches: 'critical', model: 'sonnet' },
    ];
    expect(resolveModel({ type: 'critical' }, rules)).toBe('opus');
  });
});

describe('processJob quota_exceeded handling', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetSettings();
    resetRunners();
    registerRunner(new SpyRunner());
    const { resetQueues } = await import('../../src/services/queue.service');
    resetQueues();
    const { resetEventBus } = await import('../../src/services/event-bus.service');
    resetEventBus();
  });

  it('re-enqueues with delay matching the upstream reset and does NOT throw on quota_exceeded', async () => {
    runSpy.mockResolvedValueOnce({
      status: 'quota_exceeded',
      runId: 'cli-quota-1',
      quotaResetAt: Date.now() + 600_000,
      renderedPrompt: 'rendered',
    });

    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];

    // Recovery-aware envelope mirroring what real ingest produces; the
    // re-enqueue must preserve `context` so the same ticket resumes after
    // the reset window.
    const envelope: JobEnvelope = {
      payload: '{"issue":{"key":"SPE-2009"}}',
      attempt: 1,
      context: { id: 'SPE-2009', title: 'Empty fourth page', status: 'Plan' },
    };

    await expect(
      processJob(createFakeJob(JSON.stringify(envelope), 'orig-1'), testProvider, agents),
    ).resolves.toBeUndefined();

    const { bullmqMockState } = await import('../helpers/bullmq-mock');
    // Find the test-provider's queue and inspect its addCalls. The mock's
    // queue name format is `webhooks-<provider>` per buildQueueName.
    const queue = bullmqMockState.queueInstances.find((q) => q.name === 'webhooks-test-provider');
    expect(queue).toBeDefined();
    expect(queue!.addCalls).toHaveLength(1);
    const call = queue!.addCalls[0]!;
    expect(call.name).toBe('webhook-event');
    expect(call.opts?.['delay']).toBeGreaterThan(0);
    expect(call.opts?.['delay']).toBeLessThanOrEqual(600_000);
    const requeued = JSON.parse(call.data as string) as Record<string, unknown>;
    expect(requeued).toMatchObject({
      payload: envelope.payload,
      attempt: 1,
      context: { id: 'SPE-2009', title: 'Empty fourth page', status: 'Plan' },
    });
  });

  it('schedules at least the floor delay even when reset is in the past', async () => {
    runSpy.mockResolvedValueOnce({
      status: 'quota_exceeded',
      runId: 'cli-quota-2',
      quotaResetAt: Date.now() - 60_000, // already past
      renderedPrompt: 'rendered',
    });

    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];
    const envelope: JobEnvelope = { payload: '{}', attempt: 1 };

    await processJob(createFakeJob(JSON.stringify(envelope), 'orig-2'), testProvider, agents);

    const { bullmqMockState } = await import('../helpers/bullmq-mock');
    const queue = bullmqMockState.queueInstances.find((q) => q.name === 'webhooks-test-provider');
    const delay = queue!.addCalls[0]!.opts?.['delay'] as number;
    expect(delay).toBeGreaterThanOrEqual(5_000);
  });
});

describe('processJob trace-context recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runSpy.mockResolvedValue({
      status: 'ok',
      runId: 'mock-run-id',
      renderedPrompt: 'mock-prompt',
    });
    resetSettings();
    resetRunners();
    registerRunner(new SpyRunner());
  });

  it('re-emits webhook.accepted from the worker when envelope carries context and no in-process pendingContext exists', async () => {
    const { resetActiveJobsRegistry, getActiveJobsRegistry } =
      await import('../../src/services/active-jobs.service');
    const { getEventBus, resetEventBus } = await import('../../src/services/event-bus.service');
    resetEventBus();
    resetActiveJobsRegistry();
    getActiveJobsRegistry();

    const captured: { type: string; traceId?: string; contextId?: string }[] = [];
    getEventBus().subscribe((stamped) => {
      const event = stamped.event;
      const traceId = 'traceId' in event ? event.traceId : undefined;
      const contextId = 'contextId' in event ? event.contextId : undefined;
      const entry: { type: string; traceId?: string; contextId?: string } = { type: event.type };
      if (traceId !== undefined) entry.traceId = traceId;
      if (contextId !== undefined) entry.contextId = contextId;
      captured.push(entry);
    });

    const envelope: JobEnvelope = {
      payload:
        '{"issue":{"key":"SPE-2009","fields":{"summary":"Empty fourth page","status":{"name":"Plan"},"issuetype":{"name":"Bug"}}}}',
      attempt: 1,
      context: { id: 'SPE-2009', title: 'Empty fourth page', status: 'Plan' },
    };

    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];

    await processJob(
      createFakeJob(JSON.stringify(envelope), 'recovery-job-1'),
      testProvider,
      agents,
    );

    const acceptedIndex = captured.findIndex(
      (e) => e.type === 'webhook.accepted' && e.traceId === 'recovery-job-1',
    );
    const startedIndex = captured.findIndex(
      (e) => e.type === 'job.started' && e.traceId === 'recovery-job-1',
    );
    expect(acceptedIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeGreaterThan(acceptedIndex);
    expect(captured[acceptedIndex]?.contextId).toBe('SPE-2009');

    resetEventBus();
    resetActiveJobsRegistry();
  });

  it('does not re-emit webhook.accepted when in-process pendingContext is already populated', async () => {
    const { resetActiveJobsRegistry, getActiveJobsRegistry } =
      await import('../../src/services/active-jobs.service');
    const { getEventBus, resetEventBus } = await import('../../src/services/event-bus.service');
    resetEventBus();
    resetActiveJobsRegistry();
    getActiveJobsRegistry();

    // Simulate the happy-path ingest: webhook.accepted has fired in this
    // process, populating ActiveJobsRegistry's pendingContext.
    getEventBus().publish({
      type: 'webhook.accepted',
      timestamp: 1,
      traceId: 'happy-job-1',
      provider: 'test-provider',
      contextId: 'SPE-2009',
      contextTitle: 'Empty fourth page',
      contextStatus: 'Plan',
    });

    const captured: string[] = [];
    getEventBus().subscribe((stamped) => {
      if (stamped.event.type === 'webhook.accepted' && 'traceId' in stamped.event) {
        captured.push(stamped.event.traceId);
      }
    });

    const envelope: JobEnvelope = {
      payload: '{"issue":{"key":"SPE-2009"}}',
      attempt: 1,
      context: { id: 'SPE-2009', title: 'Empty fourth page', status: 'Plan' },
    };

    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];

    await processJob(createFakeJob(JSON.stringify(envelope), 'happy-job-1'), testProvider, agents);

    // Only the pre-published webhook.accepted is on the bus from this
    // subscriber's perspective. The worker's hasPendingContext check
    // suppressed a duplicate emission.
    expect(captured.filter((id) => id === 'happy-job-1')).toHaveLength(0);

    resetEventBus();
    resetActiveJobsRegistry();
  });
});

describe('processJob model routing from agent config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runSpy.mockResolvedValue({
      status: 'ok',
      runId: 'mock-run-id',
      renderedPrompt: 'mock-prompt',
    });
    resetSettings();
    resetRunners();
    registerRunner(new SpyRunner());
  });

  it('passes model to runner when model rule matches on the routed agent', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
        modelRules: [
          {
            field: 'issue.fields.status.name',
            matches: ['Plan', 'Ready for Development'],
            model: 'anthropic/claude-opus-4-7',
          },
        ],
      }),
    ];

    await processJob(
      createFakeJob('{"issue":{"fields":{"status":{"name":"Plan"}}}}'),
      testProvider,
      agents,
    );

    expect(runSpy.mock.calls[0]![0].model).toBe('anthropic/claude-opus-4-7');
  });

  it('passes undefined model when no model rule matches', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
        modelRules: [
          {
            field: 'issue.fields.status.name',
            matches: 'Plan',
            model: 'anthropic/claude-opus-4-7',
          },
        ],
      }),
    ];

    await processJob(
      createFakeJob('{"issue":{"fields":{"status":{"name":"In Progress"}}}}'),
      testProvider,
      agents,
    );

    expect(runSpy.mock.calls[0]![0].model).toBeUndefined();
  });

  it('passes undefined model when the routed agent has no modelRules for the provider', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];

    await processJob(createFakeJob('{"event":"updated"}'), testProvider, agents);

    expect(runSpy.mock.calls[0]![0].model).toBeUndefined();
  });
});

describe('buildEnvVarNameForSecret', () => {
  it('upper-snake-cases a snake_case key', () => {
    expect(buildEnvVarNameForSecret('jira_patch_token')).toBe('JIRA_PATCH_TOKEN');
  });

  it('converts dashes to underscores', () => {
    expect(buildEnvVarNameForSecret('jira-patch-token')).toBe('JIRA_PATCH_TOKEN');
  });

  it('converts dots to underscores', () => {
    expect(buildEnvVarNameForSecret('jira.patch.token')).toBe('JIRA_PATCH_TOKEN');
  });

  it('leaves an already upper-snake-cased key unchanged', () => {
    expect(buildEnvVarNameForSecret('JIRA_PATCH_TOKEN')).toBe('JIRA_PATCH_TOKEN');
  });
});

describe('resolveEnvSecrets', () => {
  let manager: SecretManager | null = null;

  beforeEach(() => {
    manager = null;
  });

  afterEach(() => {
    if (manager) manager.close();
  });

  it('returns undefined for undefined input', () => {
    expect(resolveEnvSecrets(undefined)).toBeUndefined();
  });

  it('returns undefined for empty array', async () => {
    manager = await buildMockSecretManager([['foo', 'bar']]);
    expect(resolveEnvSecrets([])).toBeUndefined();
  });

  it('resolves declared keys to an upper-snake-cased overlay', async () => {
    manager = await buildMockSecretManager([['jira_patch_token', 'tok-abc']]);
    const overlay = resolveEnvSecrets(['jira_patch_token']);
    expect(overlay).toEqual({ JIRA_PATCH_TOKEN: 'tok-abc' });
  });

  it('throws when a declared key is not known to SecretManager', async () => {
    manager = await buildMockSecretManager([['jira_patch_token', 'tok-abc']]);
    expect(() => resolveEnvSecrets(['missing_key'])).toThrow('Secret "missing_key" not found');
  });
});

describe('processJob envSecrets injection', () => {
  let manager: SecretManager | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    loggerInfoSpy.mockClear();
    loggerDebugSpy.mockClear();
    loggerWarnSpy.mockClear();
    loggerErrorSpy.mockClear();
    runSpy.mockResolvedValue({
      status: 'ok',
      runId: 'mock-run-id',
      renderedPrompt: 'mock-prompt',
    });
    resetSettings();
    resetRunners();
    registerRunner(new SpyRunner());
    manager = null;
  });

  afterEach(() => {
    if (manager) manager.close();
  });

  it('passes resolved envSecrets to runner.run() as an env overlay', async () => {
    manager = await buildMockSecretManager([['jira_patch_token', 'tok-abc']]);
    const providerWithEnvSecrets: ProviderConfig = {
      ...testProvider,
      envSecrets: ['jira_patch_token'],
    };
    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];

    await processJob(createFakeJob('{"event":"test"}'), providerWithEnvSecrets, agents);

    expect(runSpy.mock.calls[0]![0].env).toEqual({ JIRA_PATCH_TOKEN: 'tok-abc' });
  });

  it('omits the env field on runner.run() when the provider declares no envSecrets', async () => {
    manager = await buildMockSecretManager([['jira_patch_token', 'tok-abc']]);
    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];

    await processJob(createFakeJob('{"event":"test"}'), testProvider, agents);

    expect(runSpy.mock.calls[0]![0].env).toBeUndefined();
  });

  it('never logs the resolved secret value', async () => {
    const secretValue = 'eyJ0b2tlbi1zZW50aW5lbC12YWx1ZSJ9';
    manager = await buildMockSecretManager([['jira_patch_token', secretValue]]);
    const providerWithEnvSecrets: ProviderConfig = {
      ...testProvider,
      envSecrets: ['jira_patch_token'],
    };
    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];

    await processJob(createFakeJob('{"event":"test"}'), providerWithEnvSecrets, agents);

    const allLoggerCalls = [
      ...loggerInfoSpy.mock.calls,
      ...loggerDebugSpy.mock.calls,
      ...loggerWarnSpy.mock.calls,
      ...loggerErrorSpy.mock.calls,
    ];
    const serialized = JSON.stringify(allLoggerCalls);
    expect(serialized).not.toContain(secretValue);
    // But the key name should appear so operators can confirm injection
    expect(serialized).toContain('JIRA_PATCH_TOKEN');
  });

  it('propagates SecretManager error when a declared envSecret is missing', async () => {
    manager = await buildMockSecretManager([['jira_patch_token', 'tok-abc']]);
    const providerWithBadEnvSecret: ProviderConfig = {
      ...testProvider,
      envSecrets: ['missing_secret'],
    };
    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];

    await expect(
      processJob(createFakeJob('{"event":"test"}'), providerWithBadEnvSecret, agents),
    ).rejects.toThrow('Secret "missing_secret" not found');
  });
});

describe('processJob message templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runSpy.mockResolvedValue({
      status: 'ok',
      runId: 'mock-run-id',
      renderedPrompt: 'mock-prompt',
    });
    resetSettings();
    resetRunners();
    registerRunner(new SpyRunner());
  });

  it('reads the template file from the agent dir and renders with agentDir as baseDir', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('Issue {{ issue.key }}');
    vi.mocked(renderTemplate).mockResolvedValueOnce({
      systemPrompt: '',
      body: 'rendered rule template',
    });

    const agents = [
      buildAgent(
        'patch',
        'test-provider',
        {
          rules: [
            {
              condition: { equals: { field: 'type', value: 'bug' } },
              messageTemplate: 'templates/bug-plan.md',
            },
          ],
        },
        '/agents/patch',
      ),
    ];

    await processJob(createFakeJob('{"type":"bug","issue":{"key":"SPE-1"}}'), testProvider, agents);

    expect(readFile).toHaveBeenCalledWith('/agents/patch/templates/bug-plan.md', 'utf-8');
    expect(renderTemplate).toHaveBeenCalledWith(
      'Issue {{ issue.key }}',
      expect.objectContaining({ type: 'bug' }),
      '/agents/patch',
    );
    expect(runSpy.mock.calls[0]![0].prompt).toBe('rendered rule template');
  });

  it('uses raw payload when the matched rule has no messageTemplate', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];

    await processJob(createFakeJob('{"event":"updated"}'), testProvider, agents);

    expect(renderTemplate).not.toHaveBeenCalled();
    expect(runSpy.mock.calls[0]![0].prompt).toBe('{"event":"updated"}');
  });
});
