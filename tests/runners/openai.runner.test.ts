import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { OpenAiRunner } from '../../src/runners/openai.runner';
import type { RunOptions, OpenAiRunnerConfig } from '../../src/runners/types';

const baseConfig: OpenAiRunnerConfig = {
  type: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-test-key',
};

const baseOptions: RunOptions = {
  prompt: 'summarize this',
  sessionKey: 'session-1',
  agentId: 'summarizer',
  timeoutMs: 30_000,
};

describe('OpenAiRunner', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should have name "openai"', () => {
    const runner = new OpenAiRunner(baseConfig);
    expect(runner.name).toBe('openai');
  });

  it('should report healthy (stateless)', () => {
    const runner = new OpenAiRunner(baseConfig);
    expect(runner.isHealthy()).toBe(true);
  });

  it('should call the correct endpoint with bearer token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'chatcmpl-123' }),
    });
    globalThis.fetch = mockFetch;

    const runner = new OpenAiRunner(baseConfig);
    await runner.run(baseOptions);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('should use config model when no model override', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'chatcmpl-123' }),
    });
    globalThis.fetch = mockFetch;

    const runner = new OpenAiRunner(baseConfig);
    await runner.run(baseOptions);

    const callBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(callBody.model).toBe('gpt-4o');
  });

  it('should use options model when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'chatcmpl-123' }),
    });
    globalThis.fetch = mockFetch;

    const runner = new OpenAiRunner(baseConfig);
    await runner.run({ ...baseOptions, model: 'gpt-4o-mini' });

    const callBody = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(callBody.model).toBe('gpt-4o-mini');
  });

  it('should use custom baseUrl when configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'local-123' }),
    });
    globalThis.fetch = mockFetch;

    const runner = new OpenAiRunner({
      ...baseConfig,
      baseUrl: 'http://localhost:11434/v1',
    });
    await runner.run(baseOptions);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/v1/chat/completions',
      expect.any(Object),
    );
  });

  it('should return ok on successful response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'chatcmpl-456' }),
    });

    const runner = new OpenAiRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('ok');
    expect(result.runId).toBe('chatcmpl-456');
    expect(result.renderedPrompt).toBe('summarize this');
  });

  it('should return error on non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limit exceeded'),
    });

    const runner = new OpenAiRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('error');
    expect(result.error).toContain('429');
  });

  it('should return timeout on AbortSignal timeout', async () => {
    const timeoutError = new DOMException('The operation was aborted.', 'TimeoutError');
    globalThis.fetch = vi.fn().mockRejectedValue(timeoutError);

    const runner = new OpenAiRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('timeout');
  });

  it('should return error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const runner = new OpenAiRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('error');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('should include timestamps', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'test' }),
    });

    const runner = new OpenAiRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.startedAt).toBeDefined();
    expect(result.endedAt).toBeDefined();
  });
});
