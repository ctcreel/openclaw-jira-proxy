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
  mkdir: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn().mockResolvedValue('/scratch/builder/dispatch-abc123'),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Default to "no tools on this rule" — `buildMCPBundle` returns undefined
// and `cleanupMCPBundle` is a no-op spy. Tests that exercise the
// per-dispatch cleanup-guard branch override per-call.
vi.mock('../../src/services/tools/load-for-run', () => ({
  buildMCPBundle: vi.fn().mockResolvedValue(undefined),
  cleanupMCPBundle: vi.fn().mockResolvedValue(undefined),
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

describe('processJob per-dispatch workDirectory', () => {
  // SecretManager returned by `buildMockSecretManager` registers global
  // provider state and exposes a `close()` for teardown. The describe-
  // scoped variable + afterEach mirrors the pattern in the envSecrets
  // describe blocks below so handles don't leak across suites.
  let perDispatchManager: SecretManager | null = null;
  afterEach(() => {
    if (perDispatchManager) {
      perDispatchManager.close();
      perDispatchManager = null;
    }
  });
  // Trio of test-local helpers — extracted to keep new code under
  // SonarCloud's 3% duplication ceiling on this PR's new lines.
  class ClaudeCliSpyRunner implements AgentRunner {
    readonly name = 'claude-cli';
    async run(options: RunOptions): Promise<RunResult> {
      return runSpy(options);
    }
  }

  function buildPerDispatchProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      ...testProvider,
      ...overrides,
      runner: {
        type: 'claude-cli',
        workDirectory: '/scratch/builder',
        workDirectoryStrategy: 'per-dispatch',
      },
    };
  }

  function buildBuilderAgents(): ResolvedAgent[] {
    return [
      buildAgent('builder', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runSpy.mockResolvedValue({
      status: 'ok',
      runId: 'mock-run-id',
      renderedPrompt: 'mock-prompt',
    });
    resetSettings();
    resetRunners();
    registerRunner(new ClaudeCliSpyRunner());
  });

  it('does not pass workDirectoryOverride for static (default) strategy', async () => {
    const provider: ProviderConfig = {
      ...testProvider,
      runner: { type: 'claude-cli', workDirectory: '/agents/winston' },
    };
    const agents = [
      buildAgent('winston', 'test-provider', {
        rules: [{ condition: { all_of: [] } }],
      }),
    ];

    await processJob(createFakeJob('{"event":"test"}'), provider, agents);

    expect(runSpy).toHaveBeenCalledOnce();
    expect(runSpy.mock.calls[0]![0].workDirectoryOverride).toBeUndefined();

    const fsModule = await import('node:fs/promises');
    expect(vi.mocked(fsModule.mkdtemp)).not.toHaveBeenCalled();
    expect(vi.mocked(fsModule.rm)).not.toHaveBeenCalled();
  });

  it('mktemps under workDirectory + passes override + cleans up for per-dispatch strategy', async () => {
    await processJob(
      createFakeJob('{"event":"test"}'),
      buildPerDispatchProvider(),
      buildBuilderAgents(),
    );

    const fsModule = await import('node:fs/promises');
    expect(vi.mocked(fsModule.mkdir)).toHaveBeenCalledWith('/scratch/builder', { recursive: true });
    expect(vi.mocked(fsModule.mkdtemp)).toHaveBeenCalledWith('/scratch/builder/dispatch-');
    expect(runSpy).toHaveBeenCalledOnce();
    expect(runSpy.mock.calls[0]![0].workDirectoryOverride).toBe('/scratch/builder/dispatch-abc123');
    expect(vi.mocked(fsModule.rm)).toHaveBeenCalledWith('/scratch/builder/dispatch-abc123', {
      recursive: true,
      force: true,
    });
  });

  it('cleans up the per-dispatch directory even when the runner throws', async () => {
    runSpy.mockResolvedValueOnce({
      status: 'error',
      error: 'boom',
      renderedPrompt: 'r',
    });

    await expect(
      processJob(
        createFakeJob('{"event":"test"}'),
        buildPerDispatchProvider(),
        buildBuilderAgents(),
      ),
    ).rejects.toThrow('Agent run failed: boom');

    const fsModule = await import('node:fs/promises');
    expect(vi.mocked(fsModule.rm)).toHaveBeenCalledWith('/scratch/builder/dispatch-abc123', {
      recursive: true,
      force: true,
    });
  });

  it('writes job-id + reply-context.json to .builder-context and injects BUILDER_CONTEXT_DIR env', async () => {
    const replyContext = {
      channel: 'email',
      messageId: '<abc@mail.gmail.com>',
      threadId: 't-1',
      senderEmail: 'heather@talkatlanta.info',
      originalRequestText: 'ping',
    };
    const payload = JSON.stringify({
      agentName: 'winston',
      request: 'do the thing',
      replyContext,
      senderEmail: 'heather@talkatlanta.info',
    });

    await processJob(
      createFakeJob(payload, 'dispatch-42'),
      buildPerDispatchProvider(),
      buildBuilderAgents(),
    );

    const fsModule = await import('node:fs/promises');
    expect(vi.mocked(fsModule.mkdir)).toHaveBeenCalledWith(
      '/scratch/builder/dispatch-abc123/.builder-context',
      { recursive: true },
    );
    expect(vi.mocked(fsModule.writeFile)).toHaveBeenCalledWith(
      '/scratch/builder/dispatch-abc123/.builder-context/job-id',
      'dispatch-42',
    );
    expect(vi.mocked(fsModule.writeFile)).toHaveBeenCalledWith(
      '/scratch/builder/dispatch-abc123/.builder-context/reply-context.json',
      JSON.stringify(replyContext),
    );
    expect(runSpy.mock.calls[0]![0].env?.BUILDER_CONTEXT_DIR).toBe(
      '/scratch/builder/dispatch-abc123/.builder-context',
    );
  });

  it('omits reply-context.json when the dispatch payload has no replyContext field', async () => {
    await processJob(
      createFakeJob('{"agentName":"builder","request":"x"}', 'job-no-rc'),
      buildPerDispatchProvider(),
      buildBuilderAgents(),
    );

    const fsModule = await import('node:fs/promises');
    const writeCalls = vi.mocked(fsModule.writeFile).mock.calls;
    const filenames = writeCalls.map((call) => String(call[0]));
    expect(filenames).toContain('/scratch/builder/dispatch-abc123/.builder-context/job-id');
    expect(filenames.some((path) => path.endsWith('/reply-context.json'))).toBe(false);
  });

  it('removes the per-dispatch directory when the side-channel writeFile fails after mkdtemp', async () => {
    const fsModule = await import('node:fs/promises');
    // Simulate disk-full / EACCES on the FIRST writeFile (job-id). The
    // helper has already mkdtempd workDirectory; without the inner
    // try/catch in `allocatePerDispatchWorkDirectory` this would leak.
    vi.mocked(fsModule.writeFile).mockRejectedValueOnce(new Error('ENOSPC'));

    await expect(
      processJob(
        createFakeJob('{"agentName":"builder","request":"x"}'),
        buildPerDispatchProvider(),
        buildBuilderAgents(),
      ),
    ).rejects.toThrow('ENOSPC');

    expect(vi.mocked(fsModule.rm)).toHaveBeenCalledWith('/scratch/builder/dispatch-abc123', {
      recursive: true,
      force: true,
    });
    // The runner never got far enough to be invoked.
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('still cleans up the MCP bundle when per-dispatch allocation throws', async () => {
    const fsModule = await import('node:fs/promises');
    const { buildMCPBundle, cleanupMCPBundle } =
      await import('../../src/services/tools/load-for-run');
    // Stub buildMCPBundle to return a sentinel; cleanupMCPBundle is a vi.fn
    // we can assert against. Then make mkdtemp throw so per-dispatch fails.
    vi.mocked(buildMCPBundle).mockResolvedValueOnce({
      mcpConfigPath: '/scratch/builder/mock-mcp.json',
      toolConfigPath: '/scratch/builder/mock-tools.json',
      env: {},
    });
    vi.mocked(fsModule.mkdtemp).mockRejectedValueOnce(new Error('mkdtemp boom'));

    await expect(
      processJob(
        createFakeJob('{"agentName":"builder","request":"x"}'),
        buildPerDispatchProvider(),
        buildBuilderAgents(),
      ),
    ).rejects.toThrow('mkdtemp boom');

    expect(vi.mocked(cleanupMCPBundle)).toHaveBeenCalledWith({
      mcpConfigPath: '/scratch/builder/mock-mcp.json',
      toolConfigPath: '/scratch/builder/mock-tools.json',
      env: {},
    });
  });

  it('merges BUILDER_CONTEXT_DIR alongside provider-declared envSecrets', async () => {
    // The worker calls resolveEnvSecrets(provider.envSecrets) before
    // merging in the per-dispatch context env. Wire a SecretManager
    // with the declared key bound so both keys end up on the runner
    // subprocess env. Captured into describe-scoped `perDispatchManager`
    // so the afterEach can close it.
    perDispatchManager = await buildMockSecretManager([['jira_hmac', 'hmac-value']]);

    await processJob(
      createFakeJob('{"agentName":"builder","request":"x"}'),
      buildPerDispatchProvider({ envSecrets: ['jira_hmac'] }),
      buildBuilderAgents(),
    );

    const env = runSpy.mock.calls[0]![0].env;
    expect(env?.JIRA_HMAC).toBe('hmac-value');
    expect(env?.BUILDER_CONTEXT_DIR).toBe('/scratch/builder/dispatch-abc123/.builder-context');
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
      // First-generation envelope had no originalJobId — the current
      // BullMQ job id is stamped in so trace lineage survives the resume.
      originalJobId: 'orig-1',
      context: { id: 'SPE-2009', title: 'Empty fourth page', status: 'Plan' },
    });
  });

  it('does not emit job.completed for the paused jobId — only job.paused carries the cleanup signal', async () => {
    const resetAt = Date.now() + 600_000;
    runSpy.mockResolvedValueOnce({
      status: 'quota_exceeded',
      runId: 'cli-quota-3',
      quotaResetAt: resetAt,
      renderedPrompt: 'rendered',
    });

    const { getEventBus, resetEventBus } = await import('../../src/services/event-bus.service');
    resetEventBus();
    interface CapturedEvent {
      type: string;
      jobId?: string;
      originalJobId?: string;
      resumeAt?: number;
    }
    const captured: CapturedEvent[] = [];
    getEventBus().subscribe((stamped) => {
      const event = stamped.event;
      const entry: CapturedEvent = { type: event.type };
      if ('jobId' in event) entry.jobId = event.jobId;
      if ('originalJobId' in event && typeof event.originalJobId === 'string') {
        entry.originalJobId = event.originalJobId;
      }
      if ('resumeAt' in event && typeof event.resumeAt === 'number') {
        entry.resumeAt = event.resumeAt;
      }
      captured.push(entry);
    });

    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];
    const envelope: JobEnvelope = { payload: '{}', attempt: 1 };

    await processJob(createFakeJob(JSON.stringify(envelope), 'orig-3'), testProvider, agents);

    // The paused jobId must NOT appear in any job.completed event —
    // emitting one would pollute the dashboard's RECENT panel with a
    // phantom green-✓ row for work that's only delayed. Cleanup of the
    // active-jobs map happens via job.paused's originalJobId field
    // instead (see ActiveJobsRegistry.handleRequeued).
    const completedForPaused = captured.find(
      (e) => e.type === 'job.completed' && e.jobId === 'orig-3',
    );
    expect(completedForPaused).toBeUndefined();

    // job.paused must carry the paused id in originalJobId so the
    // registries know which entry to drop, AND resumeAt so the
    // dashboard can render a countdown.
    const paused = captured.find((e) => e.type === 'job.paused');
    expect(paused).toBeDefined();
    expect(paused?.originalJobId).toBe('orig-3');
    expect(paused?.resumeAt).toBe(resetAt);

    // No job.retried in the quota path — that's the failure-handler's event.
    expect(captured.find((e) => e.type === 'job.retried')).toBeUndefined();
  });

  it('persists runner-captured sessionId onto the requeued envelope so the next pickup can --resume', async () => {
    runSpy.mockResolvedValueOnce({
      status: 'quota_exceeded',
      runId: 'cli-quota-resume',
      quotaResetAt: Date.now() + 600_000,
      sessionId: 'sess-from-runner-1',
      renderedPrompt: 'rendered',
    });

    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];
    const envelope: JobEnvelope = { payload: '{}', attempt: 1 };

    await processJob(
      createFakeJob(JSON.stringify(envelope), 'orig-resume-1'),
      testProvider,
      agents,
    );

    const { bullmqMockState } = await import('../helpers/bullmq-mock');
    // Use findLast — queueInstances accumulates across tests; the freshly
    // constructed instance for THIS test is at the tail of the array.
    const queue = bullmqMockState.queueInstances.findLast(
      (q) => q.name === 'webhooks-test-provider',
    );
    const requeued = JSON.parse(queue!.addCalls[0]!.data as string) as Record<string, unknown>;
    expect(requeued.sessionId).toBe('sess-from-runner-1');
  });

  it('forwards envelope.sessionId to the runner as resumeSessionId so claude --resume runs the next pickup', async () => {
    const agents = [
      buildAgent('patch', 'test-provider', { rules: [{ condition: { all_of: [] } }] }),
    ];
    // Inbound envelope is the one a quota-paused run wrote earlier — has
    // sessionId set. processJob must thread it through to runner.run as
    // resumeSessionId; otherwise the resumed pickup spawns a fresh
    // conversation and we lose the value of capturing the id at all.
    const envelope: JobEnvelope = {
      payload: '{}',
      attempt: 1,
      sessionId: 'sess-from-prior-run',
    };

    await processJob(createFakeJob(JSON.stringify(envelope), 'resumed-1'), testProvider, agents);

    expect(runSpy.mock.calls[0]![0].resumeSessionId).toBe('sess-from-prior-run');
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
    // worker.service now forwards the rule's identity config to the
    // template engine as a 4th arg so the renderer can auto-prepend
    // IDENTITY/SOUL. The exact shape depends on whether the test rule
    // went through the schema's default; we only verify the leading args.
    expect(renderTemplate).toHaveBeenCalledWith(
      'Issue {{ issue.key }}',
      expect.objectContaining({ type: 'bug' }),
      '/agents/patch',
      expect.any(Object),
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
