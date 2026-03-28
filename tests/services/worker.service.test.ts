import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('../../src/services/session-monitor.service', () => ({
  waitForSessionIdle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('bullmq', () => {
  const Worker = vi.fn().mockImplementation((_name: string, processor: unknown) => {
    (globalThis as Record<string, unknown>).__capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  });
  return { Worker };
});

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({
    quit: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/config', () => ({
  getSettings: vi.fn(() => ({
    openclawHookUrl: 'http://127.0.0.1:18789/hooks/agent',
    openclawToken: 'test-token',
    redisUrl: 'redis://127.0.0.1:6379',
    agentId: 'patch',
    sessionsFilePath: '/tmp/test-sessions.json',
  })),
}));

vi.mock('../../src/lib/logging', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createWorker } from '../../src/services/worker.service';
import { waitForSessionIdle } from '../../src/services/session-monitor.service';

type Processor = (job: { id: string; data: string }) => Promise<void>;

function getProcessor(): Processor {
  return (globalThis as Record<string, unknown>).__capturedProcessor as Processor;
}

describe('worker.service', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(waitForSessionIdle).mockReset().mockResolvedValue(undefined);
    createWorker();
  });

  it('creates a BullMQ Worker with concurrency 1', async () => {
    const { Worker } = await import('bullmq');
    expect(Worker).toHaveBeenCalledWith(
      'jira-webhooks',
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
  });

  it('posts the payload to OpenClaw and waits for session idle', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runId: 'run-abc' }),
    });

    const processor = getProcessor();
    const payload = JSON.stringify({ issue: { key: 'SPE-1234' } });
    await processor({ id: 'j-1', data: payload });

    // Verify fetch was called with the right payload structure.
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:18789/hooks/agent',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('hook:jira:spe-1234'),
      }),
    );

    // Verify session monitor was called with the correct session key.
    expect(waitForSessionIdle).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionsFilePath: '/tmp/test-sessions.json',
        sessionKey: 'agent:patch:hook:jira:spe-1234',
      }),
    );
  });

  it('rejects when OpenClaw returns a non-2xx response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    const processor = getProcessor();
    await expect(
      processor({ id: 'j-503', data: JSON.stringify({ issue: { key: 'SPE-999' } }) }),
    ).rejects.toThrow('OpenClaw returned 503');

    // Session monitor should NOT be called if the POST fails.
    expect(waitForSessionIdle).not.toHaveBeenCalled();
  });

  it('propagates session monitor timeout as job failure', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runId: 'run-timeout' }),
    });

    vi.mocked(waitForSessionIdle).mockRejectedValue(
      new Error('Session monitor timeout: agent:patch:hook:jira:spe-slow did not go idle'),
    );

    const processor = getProcessor();
    await expect(
      processor({ id: 'j-timeout', data: JSON.stringify({ issue: { key: 'SPE-SLOW' } }) }),
    ).rejects.toThrow('Session monitor timeout');
  });

  it('handles missing issue key gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runId: 'run-nokey' }),
    });

    const processor = getProcessor();
    await processor({ id: 'j-nokey', data: '{}' });

    expect(waitForSessionIdle).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'agent:patch:hook:jira:unknown',
      }),
    );
  });

  it('handles malformed JSON payload gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runId: 'run-bad' }),
    });

    const processor = getProcessor();
    await processor({ id: 'j-bad', data: 'not-json' });

    expect(waitForSessionIdle).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'agent:patch:hook:jira:unknown',
      }),
    );
  });
});
