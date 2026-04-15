import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock child_process before importing the runner
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
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
  });

  it('should have name "claude-cli"', () => {
    const runner = new ClaudeCliRunner(baseConfig);
    expect(runner.name).toBe('claude-cli');
  });

  it('should report healthy when OAuth token is available', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    const runner = new ClaudeCliRunner(baseConfig);
    expect(runner.isHealthy()).toBe(true);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('should report unhealthy when no OAuth token is available', () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
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
    await runner.run({ ...baseOptions, model: 'anthropic/claude-opus-4-6' });

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--model', 'anthropic/claude-opus-4-6']),
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
});
