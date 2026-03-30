import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';

import type { ProviderConfig } from '../../src/config';
import {
  registerRoutingStrategy,
  resetRoutingStrategies,
  fieldEqualsStrategy,
  regexStrategy,
  defaultStrategy,
} from '../../src/strategies/routing';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/services/session-monitor.service', () => ({
  waitForSessionIdle: vi.fn().mockResolvedValue(undefined),
}));

import { processJob, parseEnvelope, resolveModel } from '../../src/services/worker.service';
import type { JobEnvelope } from '../../src/services/worker.service';
import { resetSettings } from '../../src/config';
import { waitForSessionIdle } from '../../src/services/session-monitor.service';

import type { ModelRule } from '../../src/config';

const testProvider: ProviderConfig = {
  name: 'test-provider',
  routePath: '/hooks/test',
  hmacSecret: 'test-hmac-secret',
  signatureStrategy: 'websub',
  openclawHookUrl: 'http://127.0.0.1:18789/hooks/test',
};

function createFakeJob(data: string, id = 'test-job-1'): Job<string> {
  return { id, data } as unknown as Job<string>;
}

function mockFetchOk(runId = 'run-123'): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: vi.fn().mockResolvedValue(JSON.stringify({ ok: true, runId })),
    json: vi.fn().mockResolvedValue({ ok: true, runId }),
  });
}

describe('processJob', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
    resetRoutingStrategies();
    registerRoutingStrategy(fieldEqualsStrategy);
    registerRoutingStrategy(regexStrategy);
    registerRoutingStrategy(defaultStrategy);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should resolve when gateway returns 200 and session goes idle', async () => {
    mockFetchOk();

    await expect(
      processJob(createFakeJob('{"event":"updated"}'), testProvider),
    ).resolves.toBeUndefined();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/hooks/agent'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: expect.stringMatching(/^Bearer /),
        }),
        body: expect.stringContaining('"message":"{\\"event\\":\\"updated\\"}"'),
      }),
    );

    expect(waitForSessionIdle).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringContaining('agent:'),
      }),
    );
  });

  it('should include agentId, sessionKey, and deliver in envelope', async () => {
    mockFetchOk();

    await processJob(createFakeJob('{"event":"updated"}'), testProvider);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body).toMatchObject({
      message: '{"event":"updated"}',
      agentId: 'patch',
      sessionKey: 'hook:test-provider:test-job-1',
      deliver: false,
    });
  });

  it('should throw when gateway returns non-200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue('Service Unavailable'),
    });

    await expect(processJob(createFakeJob('{}'), testProvider)).rejects.toThrow(
      'Gateway returned 503: Service Unavailable',
    );
  });

  it('should throw when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    await expect(processJob(createFakeJob('{}'), testProvider)).rejects.toThrow(
      'Connection refused',
    );
  });

  it('should forward the raw job data as message in the envelope', async () => {
    const payload = '{"issue":{"key":"SPE-1567"}}';
    mockFetchOk();

    await processJob(createFakeJob(payload), testProvider);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.message).toBe(payload);
  });

  it('should route to agent based on field-equals rule', async () => {
    mockFetchOk();

    const providerWithRouting: ProviderConfig = {
      ...testProvider,
      routing: {
        rules: [
          {
            strategy: 'field-equals',
            field: 'issue.fields.assignee.displayName',
            value: 'Patches',
            agentId: 'patch',
          },
        ],
        default: 'main',
      },
    };

    await processJob(
      createFakeJob('{"issue":{"fields":{"assignee":{"displayName":"Patches"}}}}'),
      providerWithRouting,
    );

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.agentId).toBe('patch');
  });

  it('should fall through to routing default when no rules match', async () => {
    mockFetchOk();

    const providerWithRouting: ProviderConfig = {
      ...testProvider,
      routing: {
        rules: [
          {
            strategy: 'field-equals',
            field: 'issue.fields.assignee.displayName',
            value: 'Patches',
            agentId: 'patch',
          },
        ],
        default: 'main',
      },
    };

    await processJob(
      createFakeJob('{"issue":{"fields":{"assignee":{"displayName":"Someone Else"}}}}'),
      providerWithRouting,
    );

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.agentId).toBe('main');
  });

  it('should skip forwarding when no routing match and no default', async () => {
    mockFetchOk();

    const originalAgentId = process.env.OPENCLAW_AGENT_ID;
    process.env.OPENCLAW_AGENT_ID = '';
    resetSettings();

    const providerNoDefault: ProviderConfig = {
      ...testProvider,
      routing: {
        rules: [
          {
            strategy: 'field-equals',
            field: 'issue.fields.assignee.displayName',
            value: 'Nobody',
            agentId: 'ghost',
          },
        ],
      },
    };

    await processJob(createFakeJob('{"issue":{"fields":{}}}'), providerNoDefault);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(waitForSessionIdle).not.toHaveBeenCalled();

    process.env.OPENCLAW_AGENT_ID = originalAgentId;
    resetSettings();
  });

  it('should wait for session idle after successful delivery', async () => {
    mockFetchOk('run-456');

    await processJob(createFakeJob('{"event":"test"}'), testProvider);

    expect(waitForSessionIdle).toHaveBeenCalledTimes(1);
    expect(waitForSessionIdle).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsFilePath: expect.any(String),
        sessionKey: 'agent:patch:hook:test-provider:test-job-1',
      }),
    );
  });

  it('should throw when session monitor times out', async () => {
    mockFetchOk();
    vi.mocked(waitForSessionIdle).mockRejectedValueOnce(
      new Error(
        'Session monitor timeout: agent:patch:hook:test-provider:test-job-1 did not go idle within 600000ms',
      ),
    );

    await expect(processJob(createFakeJob('{}'), testProvider)).rejects.toThrow(
      'Session monitor timeout',
    );
  });

  it('should unwrap envelope and forward original payload', async () => {
    mockFetchOk();

    const envelope: JobEnvelope = {
      payload: '{"issue":{"key":"SPE-1234"}}',
      attempt: 2,
      originalJobId: 'original-42',
    };

    await processJob(createFakeJob(JSON.stringify(envelope)), testProvider);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.message).toBe('{"issue":{"key":"SPE-1234"}}');
    // sessionKey uses originalJobId for traceability
    expect(body.sessionKey).toBe('hook:test-provider:original-42');
  });
});

describe('parseEnvelope', () => {
  it('should wrap raw string as first attempt', () => {
    const result = parseEnvelope('{"event":"updated"}');
    expect(result).toEqual({
      payload: '{"event":"updated"}',
      attempt: 1,
    });
  });

  it('should return existing envelope as-is', () => {
    const envelope: JobEnvelope = {
      payload: '{"event":"updated"}',
      attempt: 2,
      originalJobId: 'job-42',
    };
    const result = parseEnvelope(JSON.stringify(envelope));
    expect(result).toEqual(envelope);
  });

  it('should treat non-envelope JSON as raw payload', () => {
    const result = parseEnvelope('{"issue":{"key":"SPE-1"}}');
    expect(result.payload).toBe('{"issue":{"key":"SPE-1"}}');
    expect(result.attempt).toBe(1);
  });

  it('should handle malformed JSON as raw payload', () => {
    const result = parseEnvelope('not-json');
    expect(result.payload).toBe('not-json');
    expect(result.attempt).toBe(1);
  });
});

describe('resolveModel', () => {
  const statusRules: ModelRule[] = [
    {
      field: 'issue.fields.status.name',
      matches: ['Plan', 'Ready for Development'],
      model: 'anthropic/claude-opus-4-6',
    },
    {
      field: 'issue.fields.status.name',
      matches: ['Done', 'In Progress', 'To Do'],
      model: 'anthropic/claude-sonnet-4-6',
    },
  ];

  it('should return matching model for single string match', () => {
    const payload = { issue: { fields: { status: { name: 'Plan' } } } };
    expect(resolveModel(payload, statusRules)).toBe('anthropic/claude-opus-4-6');
  });

  it('should return matching model for array match', () => {
    const payload = { issue: { fields: { status: { name: 'Ready for Development' } } } };
    expect(resolveModel(payload, statusRules)).toBe('anthropic/claude-opus-4-6');
  });

  it('should return second rule when first does not match', () => {
    const payload = { issue: { fields: { status: { name: 'Done' } } } };
    expect(resolveModel(payload, statusRules)).toBe('anthropic/claude-sonnet-4-6');
  });

  it('should return undefined when no rules match', () => {
    const payload = { issue: { fields: { status: { name: 'Unknown' } } } };
    expect(resolveModel(payload, statusRules)).toBeUndefined();
  });

  it('should return undefined when rules are undefined', () => {
    expect(resolveModel({ foo: 'bar' }, undefined)).toBeUndefined();
  });

  it('should return undefined when rules are empty', () => {
    expect(resolveModel({ foo: 'bar' }, [])).toBeUndefined();
  });

  it('should return undefined when field path does not exist', () => {
    const rules: ModelRule[] = [
      { field: 'deeply.nested.missing', matches: 'value', model: 'opus' },
    ];
    expect(resolveModel({}, rules)).toBeUndefined();
  });

  it('should match single string in matches against single field value', () => {
    const rules: ModelRule[] = [{ field: 'action', matches: 'created', model: 'opus' }];
    expect(resolveModel({ action: 'created' }, rules)).toBe('opus');
  });

  it('should match when field value is an array containing a match', () => {
    const rules: ModelRule[] = [{ field: 'tags', matches: 'urgent', model: 'opus' }];
    expect(resolveModel({ tags: ['urgent', 'bug'] }, rules)).toBe('opus');
  });

  it('should return first matching rule (priority order)', () => {
    const rules: ModelRule[] = [
      { field: 'type', matches: 'critical', model: 'opus' },
      { field: 'type', matches: 'critical', model: 'sonnet' },
    ];
    expect(resolveModel({ type: 'critical' }, rules)).toBe('opus');
  });
});

describe('processJob model routing', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
    resetRoutingStrategies();
    registerRoutingStrategy(fieldEqualsStrategy);
    registerRoutingStrategy(regexStrategy);
    registerRoutingStrategy(defaultStrategy);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should include model in gateway envelope when rule matches', async () => {
    mockFetchOk();

    const providerWithModel: ProviderConfig = {
      ...testProvider,
      modelRules: [
        {
          field: 'issue.fields.status.name',
          matches: ['Plan', 'Ready for Development'],
          model: 'anthropic/claude-opus-4-6',
        },
      ],
    };

    await processJob(
      createFakeJob('{"issue":{"fields":{"status":{"name":"Plan"}}}}'),
      providerWithModel,
    );

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.model).toBe('anthropic/claude-opus-4-6');
  });

  it('should omit model from gateway envelope when no rule matches', async () => {
    mockFetchOk();

    const providerWithModel: ProviderConfig = {
      ...testProvider,
      modelRules: [
        {
          field: 'issue.fields.status.name',
          matches: 'Plan',
          model: 'anthropic/claude-opus-4-6',
        },
      ],
    };

    await processJob(
      createFakeJob('{"issue":{"fields":{"status":{"name":"In Progress"}}}}'),
      providerWithModel,
    );

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.model).toBeUndefined();
  });

  it('should omit model when provider has no modelRules', async () => {
    mockFetchOk();

    await processJob(createFakeJob('{"event":"updated"}'), testProvider);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.model).toBeUndefined();
  });
});
