import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';

import type { ProviderConfig } from '../../src/config';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { processJob } from '../../src/services/worker.service';

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
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should resolve when gateway returns 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{"ok":true}'),
    });

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
        body: JSON.stringify({ message: '{"event":"updated"}' }),
      }),
    );
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

  it('should forward the raw job data as the request body', async () => {
    const payload = '{"issue":{"key":"SPE-1567"}}';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{"ok":true}'),
    });

    await processJob(createFakeJob(payload), testProvider);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ message: payload }) }),
    );
  });
});
