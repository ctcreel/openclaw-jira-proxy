import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type * as NodeFs from 'node:fs';

// Mock child_process before importing the runner
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock node:fs so isHealthy() doesn't pick up the developer's real
// ~/.claude/.credentials.json file. isHealthy is OR: env token OR file.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  return { ...actual, existsSync: vi.fn(() => false) };
});

// Logger mock — lets us assert the new "Agent run usage" log line emitted
// from installStreamParser when a result event is parsed.
const { loggerInfoSpy, loggerErrorSpy } = vi.hoisted(() => ({
  loggerInfoSpy: vi.fn(),
  loggerErrorSpy: vi.fn(),
}));

vi.mock('../../src/lib/logging', () => ({
  getLogger: (): Record<string, ReturnType<typeof vi.fn>> => ({
    info: loggerInfoSpy,
    debug: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorSpy,
  }),
  setupLogging: vi.fn(),
  resetLogging: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ClaudeCliRunner } from '../../src/runners/claude-cli.runner';
import type { RunOptions, ClaudeCliRunnerConfig } from '../../src/runners/types';

const baseConfig: ClaudeCliRunnerConfig = {
  type: 'claude-cli',
  workDirectory: '/tmp/test-workspace',
};

const baseOptions: RunOptions = {
  prompt: 'fix the bug',
  sessionKey: 'session-1',
  agentId: 'patch',
  timeoutMs: 60_000,
};

function createMockProcess(exitCode: number, stdout = '', stderr = ''): EventEmitter {
  const proc = new EventEmitter();
  const stdoutStream = Readable.from([stdout]);
  const stderrStream = Readable.from([stderr]);

  Object.assign(proc, {
    stdout: stdoutStream,
    stderr: stderrStream,
    killed: false,
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
    }),
  });

  // Emit close event on next tick to simulate process completion
  process.nextTick(() => {
    (proc as EventEmitter).emit('close', exitCode);
  });

  return proc;
}

describe('ClaudeCliRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerInfoSpy.mockClear();
    loggerErrorSpy.mockClear();
  });

  it('should have name "claude-cli"', () => {
    const runner = new ClaudeCliRunner(baseConfig);
    expect(runner.name).toBe('claude-cli');
  });

  it('should report healthy when OAuth token env var is set', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    vi.mocked(existsSync).mockReturnValue(false);
    const runner = new ClaudeCliRunner(baseConfig);
    expect(runner.isHealthy()).toBe(true);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('should report healthy when file-based credentials exist', () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.mocked(existsSync).mockReturnValue(true);
    const runner = new ClaudeCliRunner(baseConfig);
    expect(runner.isHealthy()).toBe(true);
  });

  it('should report unhealthy when neither env token nor credentials file exists', () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.mocked(existsSync).mockReturnValue(false);
    const runner = new ClaudeCliRunner(baseConfig);
    expect(runner.isHealthy()).toBe(false);
  });

  it('should spawn claude with correct args', async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner(baseConfig);
    await runner.run(baseOptions);

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', 'fix the bug', '--output-format', 'stream-json']),
      expect.objectContaining({ cwd: '/tmp/test-workspace' }),
    );
  });

  it('should use custom binary when configured', async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner({ ...baseConfig, binary: '/usr/local/bin/claude' });
    await runner.run(baseOptions);

    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('should include --model when model is specified', async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner(baseConfig);
    await runner.run({ ...baseOptions, model: 'anthropic/claude-opus-4-7' });

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--model', 'anthropic/claude-opus-4-7']),
      expect.any(Object),
    );
  });

  it('should include --system-prompt when configured', async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner({ ...baseConfig, systemPrompt: 'You are Patch.' });
    await runner.run(baseOptions);

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--system-prompt', 'You are Patch.']),
      expect.any(Object),
    );
  });

  // The "Agent run usage" path's `createMockProcess` races stdout flushing
  // against `process.nextTick(close)`, which works for the existing
  // resolves-on-close tests but fails when the close handler depends on
  // stdout-derived state (e.g. the quota signal). Shared driver below
  // gives the parser a deterministic chance to consume stdout before
  // close fires.
  function runWithDeterministicStreams(args: {
    readonly stdoutLines: readonly string[];
    readonly stderr?: string;
    readonly exitCode: number;
  }): Promise<{ result: Awaited<ReturnType<ClaudeCliRunner['run']>> }> {
    const proc = new EventEmitter();
    const stdoutStream = new Readable({ read(): void {} });
    const stderrStream = new Readable({ read(): void {} });
    Object.assign(proc, {
      stdout: stdoutStream,
      stderr: stderrStream,
      killed: false,
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(proc as never);

    const runner = new ClaudeCliRunner(baseConfig);
    const runPromise = runner.run(baseOptions);
    for (const line of args.stdoutLines) stdoutStream.push(line);
    stdoutStream.push(null);
    if (args.stderr !== undefined) stderrStream.push(args.stderr);
    stderrStream.push(null);
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        proc.emit('close', args.exitCode);
        runPromise.then((result) => resolve({ result })).catch(reject);
      });
    });
  }

  it('captures session_id from the system.init event and surfaces it in RunResult', async () => {
    // Production-shape stream: system.init first (carries session_id),
    // then assistant content, then close. The runner stores session_id
    // even on the happy path so the worker can persist it for any
    // future requeue.
    const initEvent = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-cap-1',
    });
    const resultEvent = JSON.stringify({ type: 'result', num_turns: 1, total_cost_usd: 0.01 });
    const { result } = await runWithDeterministicStreams({
      stdoutLines: [`${initEvent}\n${resultEvent}\n`],
      exitCode: 0,
    });
    expect(result.status).toBe('ok');
    expect(result.sessionId).toBe('sess-cap-1');
  });

  it('returns quota_exceeded with parsed resetAt when the CLI emits the limit message', async () => {
    // Production-shape stream: a single assistant text block carrying the
    // "You've hit your limit" message, followed by exit 1. This is the
    // exact failure mode that produced 9 cascading retries before the
    // quota-aware path landed.
    const limitEvent = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: "You've hit your limit · resets 6:40pm (UTC)" }],
      },
    });
    const { result } = await runWithDeterministicStreams({
      stdoutLines: [`${limitEvent}\n`],
      exitCode: 1,
    });

    expect(result.status).toBe('quota_exceeded');
    expect(result.quotaResetAt).toBeTypeOf('number');
    expect(result.quotaResetAt!).toBeGreaterThan(Date.now() - 60_000);
    // The error path is intentionally NOT taken even though exit was 1 —
    // this is what stops retries from being burned on the same wall.
    expect(result.error).toBeUndefined();
  });

  it('defaults --max-turns to 150 when options.maxTurns is omitted', async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner(baseConfig);
    await runner.run(baseOptions);

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    const idx = args.indexOf('--max-turns');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('150');
  });

  it('passes options.maxTurns through to --max-turns when set', async () => {
    // Per-rule override path: rules whose work cascades wider than 150
    // turns (e.g. SPE-2010-class tuple-shape changes across 18 test
    // files) opt in via the rule's `maxTurns` field; the worker forwards
    // it as RunOptions.maxTurns; the runner stamps the CLI flag.
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner(baseConfig);
    await runner.run({ ...baseOptions, maxTurns: 500 });

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    const idx = args.indexOf('--max-turns');
    expect(args[idx + 1]).toBe('500');
  });

  it('passes --resume <id> to claude when options.resumeSessionId is set', async () => {
    // Quota-pause recovery path: the worker pulls envelope.sessionId off
    // a previously-paused run and forwards it as resumeSessionId. The
    // runner must invoke claude with --resume so the conversation
    // continues from the prior assistant tip rather than starting fresh.
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner(baseConfig);
    await runner.run({ ...baseOptions, resumeSessionId: 'sess-resumed-1' });

    const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
    const resumeIndex = args.indexOf('--resume');
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(args[resumeIndex + 1]).toBe('sess-resumed-1');
    // System prompt is intentionally NOT passed on resume — it's already
    // cached in the existing session and supplying it again would either
    // be ignored or counted as a fresh turn.
    expect(args).not.toContain('--system-prompt');
  });

  it('still returns generic error for non-quota stderr-y failures', async () => {
    const { result } = await runWithDeterministicStreams({
      stdoutLines: [],
      stderr: 'segfault',
      exitCode: 1,
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('segfault');
  });

  it('should return ok on exit code 0', async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('ok');
    expect(result.renderedPrompt).toBe('fix the bug');
  });

  it('should return error on non-zero exit code', async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(1, '', 'Command failed') as never);
    const runner = new ClaudeCliRunner(baseConfig);
    const result = await runner.run(baseOptions);

    expect(result.status).toBe('error');
    expect(result.error).toBeDefined();
  });

  it('should return error on spawn error', async () => {
    const proc = new EventEmitter();
    Object.assign(proc, {
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      killed: false,
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(proc as never);

    const runner = new ClaudeCliRunner(baseConfig);
    const resultPromise = runner.run(baseOptions);

    process.nextTick(() => {
      proc.emit('error', new Error('ENOENT: command not found'));
    });

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('ENOENT');
  });

  it('should capture renderedPrompt', async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner(baseConfig);
    const result = await runner.run(baseOptions);
    expect(result.renderedPrompt).toBe('fix the bug');
  });

  it('should include startedAt and endedAt', async () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
    const runner = new ClaudeCliRunner(baseConfig);
    const result = await runner.run(baseOptions);
    expect(result.startedAt).toBeDefined();
    expect(result.endedAt).toBeDefined();
  });

  describe('Agent run usage log', () => {
    it('emits "Agent run usage" with cache stats when a result event arrives', async () => {
      const resultLine =
        JSON.stringify({
          type: 'result',
          num_turns: 3,
          total_cost_usd: 0.0123,
          usage: {
            input_tokens: 12,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 56_713,
            output_tokens: 88,
          },
        }) + '\n';

      vi.mocked(spawn).mockReturnValue(createMockProcess(0, resultLine) as never);
      const runner = new ClaudeCliRunner(baseConfig);
      await runner.run({
        ...baseOptions,
        traceId: 'trace-xyz',
        jobId: 'job-1',
      });

      const usageCall = loggerInfoSpy.mock.calls.find((call) => call[1] === 'Agent run usage');
      expect(usageCall).toBeDefined();
      expect(usageCall![0]).toMatchObject({
        traceId: 'trace-xyz',
        jobId: 'job-1',
        inputTokens: 12,
        cacheReadTokens: 56_713,
        cacheCreationTokens: 0,
        outputTokens: 88,
        contextTokens: 56_725,
        numTurns: 3,
        costUsd: 0.0123,
      });
      expect(typeof (usageCall![0] as { runId: string }).runId).toBe('string');
    });

    it('does not emit "Agent run usage" when no result event is parsed', async () => {
      vi.mocked(spawn).mockReturnValue(createMockProcess(0, '') as never);
      const runner = new ClaudeCliRunner(baseConfig);
      await runner.run(baseOptions);

      const usageCall = loggerInfoSpy.mock.calls.find((call) => call[1] === 'Agent run usage');
      expect(usageCall).toBeUndefined();
    });
  });

  describe('env overlay', () => {
    it('merges options.env on top of process.env when provided', async () => {
      vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
      const runner = new ClaudeCliRunner(baseConfig);
      await runner.run({ ...baseOptions, env: { PATCH_JIRA_TOKEN: 'tok-abc' } });

      const spawnArgs = vi.mocked(spawn).mock.calls[0]!;
      const spawnOptions = spawnArgs[2] as { env?: Record<string, string> };
      expect(spawnOptions.env).toBeDefined();
      expect(spawnOptions.env!['PATCH_JIRA_TOKEN']).toBe('tok-abc');
      // process.env entries remain available
      expect(spawnOptions.env!['PATH']).toBe(process.env['PATH']);
    });

    it('passes process.env through unchanged when options.env is omitted', async () => {
      vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
      const runner = new ClaudeCliRunner(baseConfig);
      await runner.run(baseOptions);

      const spawnArgs = vi.mocked(spawn).mock.calls[0]!;
      const spawnOptions = spawnArgs[2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env).toBe(process.env);
    });

    it('options.env overrides same-named keys from process.env', async () => {
      process.env['OVERRIDE_ME'] = 'original';
      try {
        vi.mocked(spawn).mockReturnValue(createMockProcess(0) as never);
        const runner = new ClaudeCliRunner(baseConfig);
        await runner.run({ ...baseOptions, env: { OVERRIDE_ME: 'overlay' } });

        const spawnArgs = vi.mocked(spawn).mock.calls[0]!;
        const spawnOptions = spawnArgs[2] as { env?: Record<string, string> };
        expect(spawnOptions.env!['OVERRIDE_ME']).toBe('overlay');
      } finally {
        delete process.env['OVERRIDE_ME'];
      }
    });
  });
});
