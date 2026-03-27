import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// --- Mock WebSocket ---

class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];
  close = vi.fn();

  constructor() {
    super();
    MockWebSocket.instances.push(this);
    // Simulate async handshake
    setImmediate(() => this.emit('open'));
  }

  simulateDone(runId: string): void {
    this.emit('message', Buffer.from(JSON.stringify({ runId, status: 'done' })));
  }

  simulateNonJsonFrame(): void {
    this.emit('message', Buffer.from('ping'));
  }
}

vi.mock('ws', () => ({
  default: vi.fn().mockImplementation(() => new MockWebSocket()),
}));

vi.mock('bullmq', () => {
  const Worker = vi.fn().mockImplementation((_name: string, processor: unknown) => {
    (globalThis as Record<string, unknown>).__capturedProcessor = processor;
    return { on: vi.fn() };
  });
  return { Worker };
});

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/config', () => ({
  getSettings: vi.fn(() => ({
    openclawHookUrl: 'http://127.0.0.1:18789/hooks/jira',
    openclawToken: 'test-token',
    redisUrl: 'redis://127.0.0.1:6379',
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

type Processor = (job: { id: string; data: string }) => Promise<void>;

function getProcessor(): Processor {
  return (globalThis as Record<string, unknown>).__capturedProcessor as Processor;
}

// Helper: wait for all pending setImmediate callbacks
function flushImmediate(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('worker.service', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    mockFetch.mockReset();
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

  it('opens WebSocket before firing the POST (race condition fix)', async () => {
    const callOrder: string[] = [];
    const { default: WS } = await import('ws');

    vi.mocked(WS).mockImplementation(() => {
      callOrder.push('ws-constructed');
      return new MockWebSocket() as unknown as InstanceType<typeof WS>;
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => {
        callOrder.push('fetch-called');
        return { ok: true, runId: 'run-order' };
      },
    });

    MockWebSocket.instances = [];
    createWorker();
    const processor = getProcessor();
    const jobPromise = processor({ id: 'j-order', data: '{}' });

    await flushImmediate();
    await flushImmediate();

    for (const ws of MockWebSocket.instances) {
      ws.simulateDone('run-order');
    }

    await jobPromise;

    const firstWsIdx = callOrder.indexOf('ws-constructed');
    const fetchIdx = callOrder.indexOf('fetch-called');
    expect(firstWsIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeGreaterThan(firstWsIdx);
  });

  it('resolves when the done message matches the runId', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runId: 'run-match' }),
    });

    const processor = getProcessor();
    const jobPromise = processor({ id: 'j-match', data: '{}' });

    await flushImmediate();
    await flushImmediate();

    MockWebSocket.instances.at(-1)!.simulateDone('run-match');

    await expect(jobPromise).resolves.toBeUndefined();
  });

  it('ignores non-JSON WS frames and does not throw', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runId: 'run-nonjson' }),
    });

    const processor = getProcessor();
    const jobPromise = processor({ id: 'j-nonjson', data: '{}' });

    await flushImmediate();
    await flushImmediate();

    const ws = MockWebSocket.instances.at(-1)!;
    ws.simulateNonJsonFrame(); // should be silently ignored
    ws.simulateDone('run-nonjson');

    await expect(jobPromise).resolves.toBeUndefined();
  });

  it('does not resolve on a done message for a different runId, then times out', async () => {
    vi.useFakeTimers();

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, runId: 'run-correct' }),
    });

    createWorker();
    const processor = getProcessor();
    // Attach catch immediately so the rejection is always handled
    let caughtError: Error | null = null;
    const jobPromise = processor({ id: 'j-wrongid', data: '{}' }).catch((e: Error) => {
      caughtError = e;
    });

    await vi.runAllTimersAsync();

    const ws = MockWebSocket.instances.at(-1)!;
    ws.simulateDone('run-wrong'); // wrong runId — must not resolve

    vi.advanceTimersByTime(31_000); // past 30s timeout
    await vi.runAllTimersAsync();

    await jobPromise;
    expect(caughtError).not.toBeNull();
    expect((caughtError as Error).message).toContain('WebSocket timeout waiting for runId=run-correct');

    vi.useRealTimers();
  });

  it('rejects when OpenClaw returns a non-2xx response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    const processor = getProcessor();
    let caughtError: Error | null = null;
    const jobPromise = processor({ id: 'j-503', data: '{}' }).catch((e: Error) => {
      caughtError = e;
    });

    await flushImmediate();
    await flushImmediate();
    await jobPromise;

    expect(caughtError).not.toBeNull();
    expect((caughtError as Error).message).toContain('OpenClaw returned 503');
  });

  it('closes the socket in the finally block even when the job throws', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    MockWebSocket.instances = [];
    createWorker();
    const processor = getProcessor();
    const jobPromise = processor({ id: 'j-close', data: '{}' }).catch(() => {
      // expected rejection — suppress unhandled
    });

    await flushImmediate();
    await flushImmediate();
    await jobPromise;

    expect(MockWebSocket.instances.at(-1)!.close).toHaveBeenCalled();
  });
});
