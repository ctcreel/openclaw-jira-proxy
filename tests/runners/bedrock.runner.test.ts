import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BedrockRunner } from '../../src/runners/bedrock.runner';
import type { RunOptions, BedrockRunnerConfig } from '../../src/runners/types';

const baseConfig: BedrockRunnerConfig = {
  type: 'bedrock',
  modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
  region: 'us-east-1',
};

const baseOptions: RunOptions = {
  prompt: 'classify this document',
  sessionKey: 'session-1',
  agentId: 'classifier',
  timeoutMs: 60_000,
};

describe('BedrockRunner', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Set up env vars for credential resolution
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
  });

  it('should have name "bedrock"', () => {
    const runner = new BedrockRunner(baseConfig);
    expect(runner.name).toBe('bedrock');
  });

  it('should report healthy (stateless)', () => {
    const runner = new BedrockRunner(baseConfig);
    expect(runner.isHealthy()).toBe(true);
  });

  it('should call the correct Bedrock endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'bedrock-run-1' }),
    });
    globalThis.fetch = mockFetch;

    const runner = new BedrockRunner(baseConfig);
    await runner.run(baseOptions);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(
        `bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(baseConfig.modelId)}/invoke`,
      ),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('should include SigV4 authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'bedrock-run-1' }),
    });
    globalThis.fetch = mockFetch;

    const runner = new BedrockRunner(baseConfig);
    await runner.run(baseOptions);

    const callHeaders = mockFetch.mock.calls[0]![1].headers;
    expect(callHeaders.authorization).toMatch(/^AWS4-HMAC-SHA256/);
  });

  it('should return ok on successful response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'bedrock-run-1' }),
    });

    const runner = new BedrockRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('ok');
    expect(result.renderedPrompt).toBe('classify this document');
  });

  it('should return error on non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('ValidationException: invalid model'),
    });

    const runner = new BedrockRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('error');
    expect(result.error).toContain('400');
  });

  it('should return timeout on AbortSignal timeout', async () => {
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError');
    globalThis.fetch = vi.fn().mockRejectedValue(timeoutError);

    const runner = new BedrockRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('timeout');
  });

  it('should use options model when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'bedrock-run-1' }),
    });
    globalThis.fetch = mockFetch;

    const runner = new BedrockRunner(baseConfig);
    await runner.run({ ...baseOptions, model: 'anthropic.claude-sonnet-4-6-v1' });

    const callUrl = mockFetch.mock.calls[0]![0] as string;
    expect(callUrl).toContain(encodeURIComponent('anthropic.claude-sonnet-4-6-v1'));
  });

  it('should throw when no AWS credentials are available', async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;

    // Mock fetch to reject the IMDS call
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('IMDS not available'));

    const runner = new BedrockRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('error');
    expect(result.error).toContain('credentials');
  });

  it('should include timestamps', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'bedrock-run-1' }),
    });

    const runner = new BedrockRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.startedAt).toBeDefined();
    expect(result.endedAt).toBeDefined();
  });
});
