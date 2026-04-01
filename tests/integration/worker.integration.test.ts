import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { Job } from 'bullmq';

import type { ProviderConfig } from '../../src/config';
import { resetSettings } from '../../src/config';
import type { GatewayClient, AgentRunResult } from '../../src/services/gateway-client';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { processJob } from '../../src/services/worker.service';

const mockRunAndWait = vi
  .fn<[Record<string, unknown>, number], Promise<AgentRunResult>>()
  .mockResolvedValue({
    runId: 'integration-run-id',
    status: 'ok',
  });

const mockGatewayClient = {
  runAndWait: mockRunAndWait,
  connect: vi.fn(),
  close: vi.fn(),
} as unknown as GatewayClient;

function createFakeJob(data: string, id = 'integration-job-1'): Job<string> {
  return { id, data } as unknown as Job<string>;
}

const provider: ProviderConfig = {
  name: 'integration-test',
  routePath: '/hooks/integration',
  hmacSecret: 'integration-secret',
  signatureStrategy: 'websub',
  openclawHookUrl: 'http://unused',
};

describe('Worker integration (GatewayClient.runAndWait)', () => {
  beforeAll(() => {
    process.env.OPENCLAW_TOKEN = 'integration-test-token';
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
  });

  afterEach(() => {
    mockRunAndWait.mockClear();
  });

  afterAll(() => {
    delete process.env.OPENCLAW_TOKEN;
    delete process.env.OPENCLAW_AGENT_ID;
    resetSettings();
  });

  it('should deliver job message via runAndWait with isolated session key', async () => {
    const payload = '{"event":"updated"}';

    await processJob(createFakeJob(payload), provider, mockGatewayClient);

    expect(mockRunAndWait).toHaveBeenCalledOnce();
    const call = mockRunAndWait.mock.calls[0];
    expect(call[0].sessionKey).toBe('hook:integration-test:integration-job-1');
    expect(call[0].agentId).toBe('patch');
    expect(call[0].message).toBe(payload);
  });

  it('should process multiple jobs sequentially', async () => {
    await processJob(createFakeJob('{"event":"first"}', 'job-1'), provider, mockGatewayClient);
    await processJob(createFakeJob('{"event":"second"}', 'job-2'), provider, mockGatewayClient);

    expect(mockRunAndWait).toHaveBeenCalledTimes(2);
    expect(mockRunAndWait.mock.calls[0][0].message).toBe('{"event":"first"}');
    expect(mockRunAndWait.mock.calls[1][0].message).toBe('{"event":"second"}');
  });

  it('should propagate error status as thrown error', async () => {
    mockRunAndWait.mockResolvedValueOnce({
      runId: 'err-run',
      status: 'error',
      error: 'Something broke',
    });

    await expect(processJob(createFakeJob('{}'), provider, mockGatewayClient)).rejects.toThrow(
      'Agent run failed: Something broke',
    );
  });
});
