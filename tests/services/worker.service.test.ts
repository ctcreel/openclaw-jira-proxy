import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { processJob } from '../../src/services/worker.service';

function createFakeJob(data: string): Job<string> {
  return { id: 'test-job-1', data } as unknown as Job<string>;
}

describe('processJob', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should resolve when fetch returns 200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    await expect(processJob(createFakeJob('{"event":"issue_updated"}'))).resolves.toBeUndefined();
  });

  it('should resolve when fetch returns 202', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
    });

    await expect(processJob(createFakeJob('{"event":"issue_created"}'))).resolves.toBeUndefined();
  });

  it('should throw when OpenClaw returns 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error'),
    });

    await expect(processJob(createFakeJob('{}'))).rejects.toThrow('OpenClaw returned 500');
  });

  it('should throw when OpenClaw returns 400', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('Bad Request'),
    });

    await expect(processJob(createFakeJob('{}'))).rejects.toThrow('OpenClaw returned 400');
  });

  it('should propagate network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(processJob(createFakeJob('{}'))).rejects.toThrow('ECONNREFUSED');
  });

  it('should send correct headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    await processJob(createFakeJob('{}'));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-openclaw-token',
        },
      }),
    );
  });

  it('should use openclawHookUrl from config', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;

    await processJob(createFakeJob('{}'));

    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:18789/hooks/jira', expect.any(Object));
  });

  it('should send job data as request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = mockFetch;
    const payload = '{"webhookEvent":"jira:issue_updated","issue_event_type_name":"issue_generic"}';

    await processJob(createFakeJob(payload));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: payload }),
    );
  });
});
