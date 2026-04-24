import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OpenClawRunner } from '../../src/runners/openclaw.runner';
import type { GatewayClient, AgentRunResult } from '../../src/services/gateway-client';
import type { RunOptions } from '../../src/runners/types';

const baseOptions: RunOptions = {
  prompt: 'test prompt',
  sessionKey: 'session-1',
  agentId: 'patch',
  timeoutMs: 60_000,
};

function createMockGatewayClient(
  overrides?: Partial<{
    runAndWait: GatewayClient['runAndWait'];
    isConnected: GatewayClient['isConnected'];
  }>,
): GatewayClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: overrides?.isConnected ?? vi.fn().mockReturnValue(true),
    runAndWait:
      overrides?.runAndWait ??
      vi.fn<[Record<string, unknown>, number], Promise<AgentRunResult>>().mockResolvedValue({
        runId: 'run-123',
        status: 'ok',
      }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  } as unknown as GatewayClient;
}

describe('OpenClawRunner', () => {
  let mockClient: GatewayClient;
  let runner: OpenClawRunner;

  beforeEach(() => {
    mockClient = createMockGatewayClient();
    runner = new OpenClawRunner(mockClient);
  });

  it('should have name "openclaw"', () => {
    expect(runner.name).toBe('openclaw');
  });

  it('should delegate connect to gateway client', async () => {
    await runner.connect();
    expect(mockClient.connect).toHaveBeenCalledOnce();
  });

  it('should delegate close to gateway client', async () => {
    await runner.close();
    expect(mockClient.close).toHaveBeenCalledOnce();
  });

  it('should delegate isHealthy to gateway client isConnected', () => {
    expect(runner.isHealthy()).toBe(true);
  });

  it('should report unhealthy when gateway is disconnected', () => {
    const client = createMockGatewayClient({
      isConnected: vi.fn().mockReturnValue(false),
    });
    const unhealthyRunner = new OpenClawRunner(client);
    expect(unhealthyRunner.isHealthy()).toBe(false);
  });

  it('should call runAndWait with correct params', async () => {
    await runner.run(baseOptions);

    expect(mockClient.runAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'test prompt',
        sessionKey: 'session-1',
        agentId: 'patch',
        bootstrapContextMode: 'lightweight',
      }),
      60_000,
    );
  });

  it('should pass model to runAndWait when provided', async () => {
    await runner.run({ ...baseOptions, model: 'anthropic/claude-opus-4-7' });

    expect(mockClient.runAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-opus-4-7' }),
      60_000,
    );
  });

  it('should capture renderedPrompt from options', async () => {
    const result = await runner.run(baseOptions);
    expect(result.renderedPrompt).toBe('test prompt');
  });

  it('should map ok status from gateway result', async () => {
    const result = await runner.run(baseOptions);
    expect(result.status).toBe('ok');
    expect(result.runId).toBe('run-123');
  });

  it('should map error status from gateway result', async () => {
    const client = createMockGatewayClient({
      runAndWait: vi.fn().mockResolvedValue({
        runId: 'err-run',
        status: 'error',
        error: 'Agent crashed',
      }),
    });
    const errorRunner = new OpenClawRunner(client);
    const result = await errorRunner.run(baseOptions);
    expect(result.status).toBe('error');
    expect(result.error).toBe('Agent crashed');
  });

  it('should map timeout status from gateway result', async () => {
    const client = createMockGatewayClient({
      runAndWait: vi.fn().mockResolvedValue({
        runId: 'timeout-run',
        status: 'timeout',
      }),
    });
    const timeoutRunner = new OpenClawRunner(client);
    const result = await timeoutRunner.run(baseOptions);
    expect(result.status).toBe('timeout');
  });

  it('should include startedAt and endedAt timestamps', async () => {
    const result = await runner.run(baseOptions);
    expect(result.startedAt).toBeDefined();
    expect(result.endedAt).toBeDefined();
  });
});
