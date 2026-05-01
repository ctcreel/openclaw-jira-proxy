import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { ShellRunner } from '../../src/runners/shell.runner';
import type { RunOptions, ShellRunnerConfig } from '../../src/runners/types';
import { resetEventBus, getEventBus } from '../../src/services/event-bus.service';
import type { ClawndomEvent } from '../../src/types/clawndom-event';

const baseOptions: RunOptions = {
  prompt: '',
  sessionKey: 'session-1',
  agentId: 'patch',
  timeoutMs: 60_000,
  traceId: 'trace-1',
  jobId: 'job-1',
};

const baseConfig: ShellRunnerConfig = {
  type: 'shell',
  command: 'echo hi',
  timeoutMs: 60_000,
};

interface MockChildOpts {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  closeDelayMs?: number;
  emitError?: Error;
}

function createMockChild(opts: MockChildOpts = {}): EventEmitter & {
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: (sig: NodeJS.Signals) => boolean;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill: (sig: NodeJS.Signals) => boolean;
  };
  proc.stdout = Readable.from(opts.stdout !== undefined ? [opts.stdout] : []);
  proc.stderr = Readable.from(opts.stderr !== undefined ? [opts.stderr] : []);
  proc.pid = 12345;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.kill = vi.fn((sig: NodeJS.Signals) => {
    proc.killed = true;
    proc.signalCode = sig;
    return true;
  });

  if (opts.emitError) {
    process.nextTick(() => proc.emit('error', opts.emitError));
    return proc;
  }

  const fire = (): void => {
    proc.exitCode = opts.exitCode ?? 0;
    proc.signalCode = opts.signal ?? null;
    proc.emit('close', opts.exitCode ?? 0, opts.signal ?? null);
  };
  if (opts.closeDelayMs && opts.closeDelayMs > 0) {
    setTimeout(fire, opts.closeDelayMs);
  } else {
    // Let stdout/stderr drain before emitting close so the runner sees the
    // captured bytes. Real child_process emits 'close' after both streams
    // have ended; replicate that ordering here.
    Promise.all([
      new Promise<void>((r) => proc.stdout.once('end', () => r())),
      new Promise<void>((r) => proc.stderr.once('end', () => r())),
    ]).then(fire);
  }
  return proc;
}

function captureEvents(): ClawndomEvent[] {
  const events: ClawndomEvent[] = [];
  getEventBus().subscribe((s) => events.push(s.event));
  return events;
}

describe('ShellRunner', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetEventBus();
    // process.kill is called for process-group signaling on timeout —
    // intercept it so tests don't actually try to signal the test runner.
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it('exposes name "shell"', () => {
    const runner = new ShellRunner(baseConfig, '/tmp/agent');
    expect(runner.name).toBe('shell');
  });

  it('returns ok on clean exit (code 0) and emits runner.complete', async () => {
    vi.mocked(spawn).mockReturnValue(createMockChild({ exitCode: 0 }) as never);
    const events = captureEvents();
    const runner = new ShellRunner(baseConfig, '/tmp/agent');

    const result = await runner.run(baseOptions);

    expect(result.status).toBe('ok');
    expect(result.runId).toMatch(/^shell-/);
    expect(result.startedAt).toBeDefined();
    expect(result.endedAt).toBeDefined();
    const completeEvent = events.find((e) => e.type === 'runner.complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent).toMatchObject({ exitCode: 0, traceId: 'trace-1', jobId: 'job-1' });
  });

  it('emits runner.tool_call on spawn with command/cwd/timeoutMs', async () => {
    vi.mocked(spawn).mockReturnValue(createMockChild({ exitCode: 0 }) as never);
    const events = captureEvents();
    const runner = new ShellRunner(baseConfig, '/tmp/agent');

    await runner.run(baseOptions);

    const toolCall = events.find((e) => e.type === 'runner.tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall).toMatchObject({
      tool: 'shell-spawn',
      args: { command: 'echo hi', cwd: '/tmp/agent', timeoutMs: 60_000 },
    });
  });

  it('returns error on non-zero exit and emits runner.error{non-zero-exit}', async () => {
    vi.mocked(spawn).mockReturnValue(
      createMockChild({ exitCode: 7, stderr: 'permission denied\nmore detail\n' }) as never,
    );
    const events = captureEvents();
    const runner = new ShellRunner(baseConfig, '/tmp/agent');

    const result = await runner.run(baseOptions);

    expect(result.status).toBe('error');
    expect(result.error).toContain('Shell exited with code 7');
    expect(result.error).toContain('permission denied');
    const err = events.find((e) => e.type === 'runner.error');
    expect(err).toMatchObject({ reason: 'non-zero-exit', exitCode: 7 });
    expect((err as { stderrTail: string }).stderrTail).toContain('permission denied');
  });

  it('returns timeout when process exceeds timeoutMs and signals the process group', async () => {
    vi.useFakeTimers();
    const child = createMockChild({ closeDelayMs: 10_000_000, exitCode: 0 });
    vi.mocked(spawn).mockReturnValue(child as never);
    const events = captureEvents();
    const runner = new ShellRunner({ ...baseConfig, timeoutMs: 1_000 }, '/tmp/agent');

    const resultPromise = runner.run(baseOptions);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

    // Process exits during the kill grace period; result is still timeout.
    child.exitCode = 0;
    child.emit('close', 0, 'SIGTERM' as NodeJS.Signals);

    const result = await resultPromise;
    expect(result.status).toBe('timeout');
    const err = events.find((e) => e.type === 'runner.error');
    expect(err).toMatchObject({ reason: 'timeout' });
  });

  it('escalates to SIGKILL after grace period and reports it as the final signal', async () => {
    vi.useFakeTimers();
    const child = createMockChild({ closeDelayMs: 10_000_000, exitCode: 0 });
    // Override exitCode to stay null so escalation is needed.
    child.exitCode = null;
    vi.mocked(spawn).mockReturnValue(child as never);
    const events = captureEvents();
    const runner = new ShellRunner({ ...baseConfig, timeoutMs: 1_000 }, '/tmp/agent');

    const resultPromise = runner.run(baseOptions);

    await vi.advanceTimersByTimeAsync(1_500); // SIGTERM fires
    await vi.advanceTimersByTimeAsync(6_000); // grace + escalation
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');

    child.exitCode = null;
    child.emit('close', null, 'SIGKILL' as NodeJS.Signals);

    const result = await resultPromise;
    expect(result.status).toBe('timeout');
    const err = events.find((e) => e.type === 'runner.error');
    expect(err).toMatchObject({ reason: 'timeout', signal: 'SIGKILL' });
  });

  it('caps captured stderr to keep memory bounded', async () => {
    const huge = 'x'.repeat(80 * 1024); // 80 KiB > 64 KiB cap
    vi.mocked(spawn).mockReturnValue(createMockChild({ exitCode: 1, stderr: huge }) as never);
    const events = captureEvents();
    const runner = new ShellRunner(baseConfig, '/tmp/agent');

    await runner.run(baseOptions);

    const err = events.find((e) => e.type === 'runner.error') as { stderrTail: string };
    expect(err.stderrTail.length).toBeLessThanOrEqual(4 * 1024);
  });

  it('emits runner.error{spawn-error} on spawn-time error', async () => {
    vi.mocked(spawn).mockReturnValue(
      createMockChild({ emitError: new Error('ENOENT: /bin/sh missing') }) as never,
    );
    const events = captureEvents();
    const runner = new ShellRunner(baseConfig, '/tmp/agent');

    const result = await runner.run(baseOptions);
    expect(result.status).toBe('error');
    expect(result.error).toContain('ENOENT');
    const err = events.find((e) => e.type === 'runner.error');
    expect(err).toMatchObject({ reason: 'spawn-error' });
  });

  it('reports signal-only termination as error with reason "signal"', async () => {
    vi.mocked(spawn).mockReturnValue(
      createMockChild({ exitCode: null, signal: 'SIGINT', stderr: 'interrupted' }) as never,
    );
    const events = captureEvents();
    const runner = new ShellRunner(baseConfig, '/tmp/agent');

    const result = await runner.run(baseOptions);
    expect(result.status).toBe('error');
    expect(result.error).toContain('SIGINT');
    const err = events.find((e) => e.type === 'runner.error');
    expect(err).toMatchObject({ reason: 'signal', signal: 'SIGINT' });
  });

  describe('cwd resolution', () => {
    it('uses config.cwd when set', async () => {
      vi.mocked(spawn).mockReturnValue(createMockChild({ exitCode: 0 }) as never);
      const runner = new ShellRunner({ ...baseConfig, cwd: '/explicit/cwd' }, '/tmp/agent');

      await runner.run(baseOptions);

      const opts = vi.mocked(spawn).mock.calls[0]![2] as { cwd?: string };
      expect(opts.cwd).toBe('/explicit/cwd');
    });

    it('falls back to defaultCwd when config.cwd is absent', async () => {
      vi.mocked(spawn).mockReturnValue(createMockChild({ exitCode: 0 }) as never);
      const runner = new ShellRunner(baseConfig, '/tmp/agent');

      await runner.run(baseOptions);

      const opts = vi.mocked(spawn).mock.calls[0]![2] as { cwd?: string };
      expect(opts.cwd).toBe('/tmp/agent');
    });
  });

  describe('env merge', () => {
    it('merges process.env, config.env, then options.env in order', async () => {
      process.env['FROM_PROCESS'] = 'a';
      try {
        vi.mocked(spawn).mockReturnValue(createMockChild({ exitCode: 0 }) as never);
        const runner = new ShellRunner({ ...baseConfig, env: { FROM_CONFIG: 'b' } }, '/tmp/agent');
        await runner.run({ ...baseOptions, env: { FROM_OPTIONS: 'c' } });

        const opts = vi.mocked(spawn).mock.calls[0]![2] as { env?: Record<string, string> };
        expect(opts.env!['FROM_PROCESS']).toBe('a');
        expect(opts.env!['FROM_CONFIG']).toBe('b');
        expect(opts.env!['FROM_OPTIONS']).toBe('c');
      } finally {
        delete process.env['FROM_PROCESS'];
      }
    });

    it('options.env overrides config.env which overrides process.env on key collision', async () => {
      process.env['LAYER'] = 'process';
      try {
        vi.mocked(spawn).mockReturnValue(createMockChild({ exitCode: 0 }) as never);
        const runner = new ShellRunner({ ...baseConfig, env: { LAYER: 'config' } }, '/tmp/agent');
        await runner.run({ ...baseOptions, env: { LAYER: 'options' } });

        const opts = vi.mocked(spawn).mock.calls[0]![2] as { env?: Record<string, string> };
        expect(opts.env!['LAYER']).toBe('options');
      } finally {
        delete process.env['LAYER'];
      }
    });
  });

  it('passes shell:true and detached:true to spawn', async () => {
    vi.mocked(spawn).mockReturnValue(createMockChild({ exitCode: 0 }) as never);
    const runner = new ShellRunner(baseConfig, '/tmp/agent');

    await runner.run(baseOptions);

    const opts = vi.mocked(spawn).mock.calls[0]![2] as {
      shell?: boolean;
      detached?: boolean;
    };
    expect(opts.shell).toBe(true);
    expect(opts.detached).toBe(true);
  });

  it('does not publish events when traceId/jobId are absent', async () => {
    vi.mocked(spawn).mockReturnValue(createMockChild({ exitCode: 0 }) as never);
    const events = captureEvents();
    const runner = new ShellRunner(baseConfig, '/tmp/agent');

    await runner.run({ ...baseOptions, traceId: undefined, jobId: undefined });

    expect(events).toHaveLength(0);
  });
});
