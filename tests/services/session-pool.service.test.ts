import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/services/dedup.service', () => ({
  getDedupRedis: vi.fn(),
}));

import { spawn } from 'node:child_process';

import { SessionPool } from '../../src/services/session-pool.service';
import type { ProviderConfig } from '../../src/config';
import type { SessionConfig } from '../../src/strategies/session-key';
import type { EventBus } from '../../src/services/event-bus.service';

interface MockProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: Readable;
  stdin: PassThrough & { end: () => void; write: (chunk: string) => boolean };
  exitCode: number | null;
  killed: boolean;
  kill: (signal?: string) => boolean;
}

function makeMockProcess(): MockProcess {
  const proc = new EventEmitter() as MockProcess;
  proc.stdout = new PassThrough();
  proc.stderr = Readable.from([]);
  const stdin = new PassThrough();
  proc.stdin = stdin as MockProcess['stdin'];
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(function (this: MockProcess): boolean {
    this.killed = true;
    this.exitCode = 143;
    setImmediate(() => this.emit('close', 143));
    return true;
  });
  // Default: when stdin closes (e.g. via shutdown), emit a clean close.
  // Tests that need to simulate hangs override this by removing the listener.
  stdin.on('finish', () => {
    setImmediate(() => {
      proc.exitCode = 0;
      proc.emit('close', 0);
    });
  });
  return proc;
}

function emitInit(proc: MockProcess, sessionId: string): void {
  proc.stdout.write(JSON.stringify({ type: 'init', session_id: sessionId }) + '\n');
}

function emitResult(proc: MockProcess, summary = 'ok'): void {
  proc.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: summary }) +
      '\n',
  );
}

function makeFakeRedis(): {
  store: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, string>();
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const set = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  const del = vi.fn(async (key: string) => {
    const had = store.has(key);
    store.delete(key);
    return had ? 1 : 0;
  });
  return { store, get, set, del };
}

interface FakeEvent {
  type: string;
  [key: string]: unknown;
}

function makeFakeEventBus(): EventBus & { events: FakeEvent[] } {
  const events: FakeEvent[] = [];
  return {
    events,
    publish: vi.fn((event: FakeEvent) => events.push(event)),
    subscribe: vi.fn(() => () => {}),
  } as unknown as EventBus & { events: FakeEvent[] };
}

const baseProvider = {
  name: 'slack-winston',
  transport: 'slack-socket',
  appTokenSecret: 'a',
  botTokenSecret: 'b',
} as unknown as ProviderConfig;

const baseSessionConfig: SessionConfig = {
  strategy: 'slack',
  ttl: 7 * 24 * 60 * 60 * 1000,
  idleTimeout: 30 * 60 * 1000,
};

const baseStrategy = {
  name: 'slack',
  extract: (): string | null => 'D123',
};

const baseRequest = {
  providerName: 'slack-winston',
  key: 'D123',
  providerConfig: baseProvider,
  sessionConfig: baseSessionConfig,
  workDirectory: '/tmp/test-workspace',
  binary: '/usr/bin/claude',
};

describe('SessionPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Each test cleans up its own pool via shutdown()
  });

  it('spawns fresh and persists session_id to Redis after the first turn (init lands mid-stream)', async () => {
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);

    const handle = await pool.acquire(baseRequest, baseStrategy);
    expect(handle.acquirePath).toBe('fresh');
    // Pre-turn, sessionId is pending — claude won't emit init until we send stdin.
    expect(handle.sessionId).toBe('<pending>');

    // Drive a turn: emit init then result in response to the stdin write.
    setImmediate(() => {
      emitInit(proc, 'session-fresh-1');
      emitResult(proc);
    });

    await handle.runTurn('hello');

    expect(handle.sessionId).toBe('session-fresh-1');
    expect(redis.set).toHaveBeenCalledWith(
      'session:slack-winston:D123',
      'session-fresh-1',
      'EX',
      7 * 24 * 60 * 60,
    );
    const spawnedEvent = bus.events.find(
      (e) => e.type === 'session.spawned',
    );
    expect(spawnedEvent).toMatchObject({
      type: 'session.spawned',
      provider: 'slack-winston',
      key: 'D123',
      session_id: 'session-fresh-1',
      mode: 'fresh',
    });

    await pool.shutdown();
  });

  it('warm-reuses an existing subprocess on a second acquire for the same key', async () => {
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);

    setImmediate(() => emitInit(proc, 'session-warm-1'));
    const first = await pool.acquire(baseRequest, baseStrategy);
    expect(first.acquirePath).toBe('fresh');

    const second = await pool.acquire(baseRequest, baseStrategy);
    expect(second.acquirePath).toBe('warm');
    // spawn called only once across two acquires
    expect(vi.mocked(spawn).mock.calls).toHaveLength(1);

    await pool.shutdown();
  });

  it('resumes from Redis when the in-memory entry is absent (cold path)', async () => {
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    redis.store.set('session:slack-winston:D123', 'session-prior-1');
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);

    const handle = await pool.acquire(baseRequest, baseStrategy);
    expect(handle.acquirePath).toBe('resume');

    // claude emits init mid-turn after stdin write — drive that.
    setImmediate(() => {
      emitInit(proc, 'session-prior-1');
      emitResult(proc);
    });

    await handle.runTurn('hello');

    expect(handle.sessionId).toBe('session-prior-1');
    const spawnArgs = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(spawnArgs).toContain('--resume');
    expect(spawnArgs).toContain('session-prior-1');

    const resumedEvent = bus.events.find(
      (e) => e.type === 'session.resumed',
    );
    expect(resumedEvent).toMatchObject({
      type: 'session.resumed',
      provider: 'slack-winston',
      key: 'D123',
      session_id: 'session-prior-1',
      mode: 'resume',
    });

    await pool.shutdown();
  });

  it('emits session.stale when --resume produces a mismatched session_id during the first turn', async () => {
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    redis.store.set('session:slack-winston:D123', 'session-stale');
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);

    const handle = await pool.acquire(baseRequest, baseStrategy);

    // claude returned a different session_id than we asked for — surfaces
    // as a session.stale event mid-turn, but the new id is persisted and
    // the turn proceeds.
    setImmediate(() => {
      emitInit(proc, 'session-actually-fresh');
      emitResult(proc);
    });
    await handle.runTurn('hello');

    expect(handle.sessionId).toBe('session-actually-fresh');
    const staleEvent = bus.events.find((e) => e.type === 'session.stale');
    expect(staleEvent).toMatchObject({
      type: 'session.stale',
      provider: 'slack-winston',
      key: 'D123',
      prior_session_id: 'session-stale',
    });

    await pool.shutdown();
  });

  it('runTurn writes the user message to stdin and resolves with events up to result', async () => {
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);
    setImmediate(() => emitInit(proc, 's-1'));
    const handle = await pool.acquire(baseRequest, baseStrategy);

    // Capture writes to stdin so we can assert on them.
    const writes: string[] = [];
    proc.stdin.on('data', (chunk: Buffer) => writes.push(chunk.toString()));

    setImmediate(() => {
      proc.stdout.write(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi' }] },
        }) + '\n',
      );
      emitResult(proc);
    });

    const events = await handle.runTurn('hello?');

    // Expect the user envelope to have been written to stdin.
    const flat = writes.join('');
    expect(flat).toContain('"type":"user"');
    expect(flat).toContain('hello?');

    // Events include at least the assistant + result.
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'result')).toBe(true);

    await pool.shutdown();
  });

  it('shutdown gracefully closes all active subprocesses', async () => {
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);
    setImmediate(() => emitInit(proc, 'shutdown-test'));
    await pool.acquire(baseRequest, baseStrategy);
    expect(pool.size()).toBe(1);

    // Make sure stdin.end triggers a close so shutdown completes.
    proc.stdin.on('end', () => {
      setImmediate(() => {
        proc.exitCode = 0;
        proc.emit('close', 0);
      });
    });

    await pool.shutdown();
    // Pool clears its map immediately on shutdown.
    expect(pool.size()).toBe(0);
  });

  it('refuses new acquires after shutdown', async () => {
    const redis = makeFakeRedis();
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);
    await pool.shutdown();
    await expect(pool.acquire(baseRequest, baseStrategy)).rejects.toThrow(/shutting down/);
  });

  it('idle reaper kills the subprocess after the configured idleTimeout and emits session.reaped', async () => {
    vi.useFakeTimers();
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);

    // Use a tiny idleTimeout for the test.
    const shortIdleConfig: SessionConfig = {
      ...baseSessionConfig,
      idleTimeout: 1_000,
    };
    const request = { ...baseRequest, sessionConfig: shortIdleConfig };

    setImmediate(() => emitInit(proc, 's-idle'));
    await vi.advanceTimersByTimeAsync(0);
    await pool.acquire(request, baseStrategy);
    expect(pool.size()).toBe(1);

    // Fast-forward past idleTimeout — reaper should fire.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000); // give graceful-close timer time to elapse

    const reaped = bus.events.find((e) => e.type === 'session.reaped');
    expect(reaped).toMatchObject({
      type: 'session.reaped',
      provider: 'slack-winston',
      key: 'D123',
    });

    vi.useRealTimers();
  });

  it('serializes concurrent runTurn calls per key (turn lock)', async () => {
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);
    setImmediate(() => emitInit(proc, 's-lock'));
    const handle = await pool.acquire(baseRequest, baseStrategy);

    const completionOrder: string[] = [];

    const turn1 = handle.runTurn('first').then(() => completionOrder.push('first'));
    const turn2 = handle.runTurn('second').then(() => completionOrder.push('second'));

    // Drive turn 1 to completion first.
    setImmediate(() => emitResult(proc, 'turn-1-done'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Now drive turn 2.
    setImmediate(() => emitResult(proc, 'turn-2-done'));

    await Promise.all([turn1, turn2]);
    expect(completionOrder).toEqual(['first', 'second']);

    await pool.shutdown();
  });

  it('first turn rejects with mid-turn exit when the subprocess exits before result', async () => {
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);

    const handle = await pool.acquire(baseRequest, baseStrategy);

    // Subprocess dies before emitting init or result — first turn should
    // reject with the mid-turn-exit message. (Stale-session fallback is
    // a known follow-up; for now BullMQ retries surface this to the
    // caller.)
    const turnPromise = handle.runTurn('hello');
    setImmediate(() => {
      proc.exitCode = 1;
      proc.emit('close', 1);
    });
    await expect(turnPromise).rejects.toThrow(/exited mid-turn/);
  });

  it('subprocess crash mid-turn rejects the in-flight runTurn', async () => {
    const proc = makeMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const redis = makeFakeRedis();
    const bus = makeFakeEventBus();
    const pool = new SessionPool({ redis, events: bus } as unknown as ConstructorParameters<
      typeof SessionPool
    >[0]);
    setImmediate(() => emitInit(proc, 's-crash'));
    const handle = await pool.acquire(baseRequest, baseStrategy);

    const turnPromise = handle.runTurn('hello?');

    setImmediate(() => {
      proc.exitCode = 137;
      proc.emit('close', 137);
    });

    await expect(turnPromise).rejects.toThrow(/exited mid-turn/);
  });
});
