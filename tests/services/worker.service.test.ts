import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../../src/lib/template/template-engine', () => ({
  renderTemplate: vi.fn().mockResolvedValue('rendered-template-output'),
}));

import { processJob, parseEnvelope, resolveModel } from '../../src/services/worker.service';
import type { JobEnvelope } from '../../src/services/worker.service';
import { resetSettings } from '../../src/config';
import { renderTemplate } from '../../src/lib/template/template-engine';
import type { GatewayClient, AgentRunResult } from '../../src/services/gateway-client';

import type { ModelRule } from '../../src/config';

const mockRunAndWait = vi
  .fn<[Record<string, unknown>, number], Promise<AgentRunResult>>()
  .mockResolvedValue({
    runId: 'mock-run-id',
    status: 'ok',
  });

const mockGatewayClient = {
  runAndWait: mockRunAndWait,
  connect: vi.fn(),
  close: vi.fn(),
} as unknown as GatewayClient;

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

describe('processJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAndWait.mockResolvedValue({ runId: 'mock-run-id', status: 'ok' });
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
    resetRoutingStrategies();
    registerRoutingStrategy(fieldEqualsStrategy);
    registerRoutingStrategy(regexStrategy);
    registerRoutingStrategy(defaultStrategy);
  });

  it('should call runAndWait with correct params on success', async () => {
    await processJob(createFakeJob('{"event":"updated"}'), testProvider, mockGatewayClient);

    expect(mockRunAndWait).toHaveBeenCalledOnce();
    expect(mockRunAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '{"event":"updated"}',
        sessionKey: 'hook:test-provider:test-job-1',
        agentId: 'patch',
      }),
      expect.any(Number),
    );
  });

  it('should use isolated session key (hook:<provider>:<traceId>)', async () => {
    await processJob(createFakeJob('{"event":"updated"}'), testProvider, mockGatewayClient);

    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].sessionKey).toBe('hook:test-provider:test-job-1');
  });

  it('should throw when runAndWait returns error status', async () => {
    mockRunAndWait.mockResolvedValueOnce({
      runId: 'err-run',
      status: 'error',
      error: 'Agent crashed',
    });

    await expect(processJob(createFakeJob('{}'), testProvider, mockGatewayClient)).rejects.toThrow(
      'Agent run failed: Agent crashed',
    );
  });

  it('should throw when runAndWait returns timeout status', async () => {
    mockRunAndWait.mockResolvedValueOnce({
      runId: 'timeout-run',
      status: 'timeout',
    });

    await expect(processJob(createFakeJob('{}'), testProvider, mockGatewayClient)).rejects.toThrow(
      'Agent run timed out (runId: timeout-run)',
    );
  });

  it('should throw when runAndWait rejects', async () => {
    mockRunAndWait.mockRejectedValueOnce(new Error('Gateway WS closed'));

    await expect(processJob(createFakeJob('{}'), testProvider, mockGatewayClient)).rejects.toThrow(
      'Gateway WS closed',
    );
  });

  it('should forward the raw job data as message', async () => {
    const payload = '{"issue":{"key":"SPE-1567"}}';

    await processJob(createFakeJob(payload), testProvider, mockGatewayClient);

    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].message).toBe(payload);
  });

  it('should route to correct agent when field-equals rule matches', async () => {
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
      mockGatewayClient,
    );

    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].agentId).toBe('patch');
  });

  it('should route to default agent when no rules match', async () => {
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
      mockGatewayClient,
    );

    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].agentId).toBe('main');
  });

  it('should skip forwarding when no routing match and no default', async () => {
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

    await processJob(
      createFakeJob('{"issue":{"fields":{}}}'),
      providerNoDefault,
      mockGatewayClient,
    );

    expect(mockRunAndWait).not.toHaveBeenCalled();

    process.env.OPENCLAW_AGENT_ID = originalAgentId;
    resetSettings();
  });

  it('should use originalJobId in session key for re-enqueued jobs', async () => {
    const envelope: JobEnvelope = {
      payload: '{"issue":{"key":"SPE-1234"}}',
      attempt: 2,
      originalJobId: 'original-42',
    };

    await processJob(createFakeJob(JSON.stringify(envelope)), testProvider, mockGatewayClient);

    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].message).toBe('{"issue":{"key":"SPE-1234"}}');
    expect(call[0].sessionKey).toBe('hook:test-provider:original-42');
  });

  it('should pass agentWaitTimeoutMs to runAndWait', async () => {
    await processJob(createFakeJob('{"event":"test"}'), testProvider, mockGatewayClient);

    const call = mockRunAndWait.mock.calls[0];
    // Default agentWaitTimeoutMs is 1_800_000
    expect(call[1]).toBe(1_800_000);
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAndWait.mockResolvedValue({ runId: 'mock-run-id', status: 'ok' });
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
    resetRoutingStrategies();
    registerRoutingStrategy(fieldEqualsStrategy);
    registerRoutingStrategy(regexStrategy);
    registerRoutingStrategy(defaultStrategy);
  });

  it('should pass model to runAndWait when model rule matches', async () => {
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
      mockGatewayClient,
    );

    expect(mockRunAndWait).toHaveBeenCalledOnce();
    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].model).toBe('anthropic/claude-opus-4-6');
  });

  it('should pass undefined model when no model rule matches', async () => {
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
      mockGatewayClient,
    );

    expect(mockRunAndWait).toHaveBeenCalledOnce();
    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].model).toBeUndefined();
  });

  it('should pass undefined model when provider has no modelRules', async () => {
    await processJob(createFakeJob('{"event":"updated"}'), testProvider, mockGatewayClient);

    expect(mockRunAndWait).toHaveBeenCalledOnce();
    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].model).toBeUndefined();
  });
});

describe('processJob message templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAndWait.mockResolvedValue({ runId: 'mock-run-id', status: 'ok' });
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
    resetRoutingStrategies();
    registerRoutingStrategy(fieldEqualsStrategy);
    registerRoutingStrategy(regexStrategy);
    registerRoutingStrategy(defaultStrategy);
  });

  it('should use rendered template as message when provider has messageTemplate', async () => {
    vi.mocked(renderTemplate).mockResolvedValueOnce('rendered provider template');

    const providerWithTemplate: ProviderConfig = {
      ...testProvider,
      messageTemplate: 'Issue {{ issue.key }}',
    };

    await processJob(
      createFakeJob('{"issue":{"key":"SPE-100"}}'),
      providerWithTemplate,
      mockGatewayClient,
    );

    expect(renderTemplate).toHaveBeenCalledWith('Issue {{ issue.key }}', {
      issue: { key: 'SPE-100' },
    });
    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].message).toBe('rendered provider template');
  });

  it('should prefer routing rule messageTemplate over provider messageTemplate', async () => {
    vi.mocked(renderTemplate).mockResolvedValueOnce('rendered rule template');

    const providerWithBoth: ProviderConfig = {
      ...testProvider,
      messageTemplate: 'provider template',
      routing: {
        rules: [
          {
            strategy: 'field-equals',
            field: 'type',
            value: 'bug',
            agentId: 'patch',
            messageTemplate: 'rule template {{ type }}',
          },
        ],
      },
    };

    await processJob(createFakeJob('{"type":"bug"}'), providerWithBoth, mockGatewayClient);

    expect(renderTemplate).toHaveBeenCalledWith('rule template {{ type }}', { type: 'bug' });
    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].message).toBe('rendered rule template');
  });

  it('should use raw payload when no template is configured', async () => {
    await processJob(createFakeJob('{"event":"updated"}'), testProvider, mockGatewayClient);

    expect(renderTemplate).not.toHaveBeenCalled();
    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].message).toBe('{"event":"updated"}');
  });
});
