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

import { processJob } from '../../src/services/worker.service';
import { resetSettings } from '../../src/config';
import { waitForSessionIdle } from '../../src/services/session-monitor.service';

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
      new Error('Session monitor timeout: agent:patch:hook:test-provider:test-job-1 did not go idle within 600000ms'),
    );

    await expect(processJob(createFakeJob('{}'), testProvider)).rejects.toThrow(
      'Session monitor timeout',
    );
  });
});
