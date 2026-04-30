import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { getLogger } from '../lib/logging';
import { getEventBus } from '../services/event-bus.service';
import type { RunnerErrorReason } from '../types/clawndom-event';
import type { AgentRunner, RunOptions, RunResult, ShellRunnerConfig } from './types';

const KILL_GRACE_MS = 5_000;
const STREAM_CAP_BYTES = 64 * 1024;
const STDERR_TAIL_BYTES = 4 * 1024;

const logger = getLogger('runner:shell');

/**
 * Bounded byte capture: keeps at most `cap` bytes by truncating from the
 * front. Avoids unbounded memory growth on commands that emit large
 * volumes of output (e.g. a runaway `find /`). The kept tail is the most
 * recent bytes — that's what's most useful for diagnosing the failure.
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}

  append(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const overflow = this.size - this.cap;
      if (head.length <= overflow) {
        this.size -= head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.size -= overflow;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString('utf-8');
  }

  tail(bytes: number): string {
    const full = Buffer.concat(this.chunks, this.size);
    const start = Math.max(0, full.length - bytes);
    return full.subarray(start).toString('utf-8');
  }
}

interface TimeoutHandle {
  clear: () => void;
  didTimeOut: () => boolean;
  didEscalate: () => boolean;
}

function scheduleProcessGroupKill(child: ChildProcess, timeoutMs: number): TimeoutHandle {
  let timedOut = false;
  let escalated = false;
  const softTimer = setTimeout(() => {
    timedOut = true;
    sendSignalToGroup(child, 'SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        escalated = true;
        sendSignalToGroup(child, 'SIGKILL');
      }
    }, KILL_GRACE_MS).unref();
  }, timeoutMs);
  softTimer.unref();
  return {
    clear: () => clearTimeout(softTimer),
    didTimeOut: () => timedOut,
    didEscalate: () => escalated,
  };
}

// With `shell: true` + `detached: true`, the Node child handle refers to
// the shell, which forks the actual command into the same process group.
// Signaling the negative pid sends to the whole group so the command
// dies with the shell. Falls back to a direct kill on EPERM/ESRCH.
function sendSignalToGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited; nothing to signal.
    }
  }
}

/**
 * Spawns a configured command on each `run()` and reports termination
 * via Clawndom's event bus.
 *
 * Constructed per-firing (not registered in the global runner registry)
 * because the command varies per scheduling rule, not per deployment.
 * The `RunOptions.timeoutMs` field is intentionally ignored — shell
 * runs honor `config.timeoutMs` so per-rule maintenance commands aren't
 * stretched by the agent-prompt-length default.
 */
export class ShellRunner implements AgentRunner {
  readonly name = 'shell';

  constructor(
    private readonly config: ShellRunnerConfig,
    private readonly defaultCwd: string,
  ) {}

  async run(options: RunOptions): Promise<RunResult> {
    return runShellCommand(this.config, this.defaultCwd, options);
  }
}

function buildSpawnEnv(
  config: ShellRunnerConfig,
  optionsEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  return { ...process.env, ...(config.env ?? {}), ...(optionsEnv ?? {}) };
}

function publishToolCall(
  options: RunOptions,
  runId: string,
  config: ShellRunnerConfig,
  cwd: string,
): void {
  if (!options.traceId || !options.jobId) return;
  getEventBus().publish({
    type: 'runner.tool_call',
    timestamp: Date.now(),
    traceId: options.traceId,
    jobId: options.jobId,
    runId,
    tool: 'shell-spawn',
    args: { command: config.command, cwd, timeoutMs: config.timeoutMs },
  });
}

function publishComplete(
  options: RunOptions,
  runId: string,
  exitCode: number,
  durationMs: number,
): void {
  if (!options.traceId || !options.jobId) return;
  getEventBus().publish({
    type: 'runner.complete',
    timestamp: Date.now(),
    traceId: options.traceId,
    jobId: options.jobId,
    runId,
    exitCode,
    durationMs,
  });
}

function publishError(
  options: RunOptions,
  runId: string,
  reason: RunnerErrorReason,
  detail: { exitCode?: number; signal?: string; stderrTail: string },
): void {
  if (!options.traceId || !options.jobId) return;
  getEventBus().publish({
    type: 'runner.error',
    timestamp: Date.now(),
    traceId: options.traceId,
    jobId: options.jobId,
    runId,
    reason,
    exitCode: detail.exitCode,
    signal: detail.signal,
    stderrTail: detail.stderrTail,
  });
}

interface ExitContext {
  startedAt: string;
  startedAtMs: number;
  runId: string;
  options: RunOptions;
  config: ShellRunnerConfig;
  stderr: TailBuffer;
  timeout: TimeoutHandle;
}

function buildResult(
  status: 'ok' | 'error' | 'timeout',
  context: ExitContext,
  errorMessage?: string,
): RunResult {
  return {
    status,
    runId: context.runId,
    startedAt: context.startedAt,
    endedAt: new Date().toISOString(),
    renderedPrompt: context.options.prompt,
    error: errorMessage,
  };
}

function handleTimeoutExit(context: ExitContext, signal: NodeJS.Signals | null): RunResult {
  const stderrTail = context.stderr.tail(STDERR_TAIL_BYTES);
  const finalSignal = context.timeout.didEscalate() ? 'SIGKILL' : (signal ?? 'SIGTERM');
  publishError(context.options, context.runId, 'timeout', { signal: finalSignal, stderrTail });
  return buildResult(
    'timeout',
    context,
    `Shell command timed out after ${context.config.timeoutMs}ms (final signal: ${finalSignal})`,
  );
}

function handleSignalExit(context: ExitContext, signal: NodeJS.Signals): RunResult {
  const stderrTail = context.stderr.tail(STDERR_TAIL_BYTES);
  publishError(context.options, context.runId, 'signal', { signal, stderrTail });
  return buildResult('error', context, `Shell command terminated by signal ${signal}`);
}

function handleNonZeroExit(context: ExitContext, code: number): RunResult {
  const stderrTail = context.stderr.tail(STDERR_TAIL_BYTES);
  const firstStderrLine = stderrTail.split('\n').find((l) => l.trim().length > 0) ?? '';
  publishError(context.options, context.runId, 'non-zero-exit', { exitCode: code, stderrTail });
  return buildResult(
    'error',
    context,
    `Shell exited with code ${code}${firstStderrLine ? `: ${firstStderrLine.trim()}` : ''}`,
  );
}

function handleCleanExit(context: ExitContext): RunResult {
  const durationMs = Date.now() - context.startedAtMs;
  publishComplete(context.options, context.runId, 0, durationMs);
  return buildResult('ok', context);
}

function resolveExit(
  context: ExitContext,
  code: number | null,
  signal: NodeJS.Signals | null,
): RunResult {
  if (context.timeout.didTimeOut()) {
    return handleTimeoutExit(context, signal);
  }
  if (signal) {
    return handleSignalExit(context, signal);
  }
  if (code === null || code !== 0) {
    return handleNonZeroExit(context, code ?? -1);
  }
  return handleCleanExit(context);
}

function runShellCommand(
  config: ShellRunnerConfig,
  defaultCwd: string,
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const runId = `shell-${startedAtMs}-${Math.random().toString(36).slice(2, 8)}`;
    const cwd = config.cwd ?? defaultCwd;
    const env = buildSpawnEnv(config, options.env);

    logger.info(
      { runId, command: config.command, cwd, timeoutMs: config.timeoutMs },
      'Spawning shell command',
    );
    publishToolCall(options, runId, config, cwd);

    let child: ChildProcess;
    try {
      child = spawn(config.command, [], {
        shell: true,
        detached: true,
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publishError(options, runId, 'spawn-error', { stderrTail: message });
      resolve({
        status: 'error',
        runId,
        startedAt,
        endedAt: new Date().toISOString(),
        renderedPrompt: options.prompt,
        error: `Shell spawn failed: ${message}`,
      });
      return;
    }

    const stdout = new TailBuffer(STREAM_CAP_BYTES);
    const stderr = new TailBuffer(STREAM_CAP_BYTES);
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.append(chunk));

    const timeout = scheduleProcessGroupKill(child, config.timeoutMs);
    const context: ExitContext = {
      startedAt,
      startedAtMs,
      runId,
      options,
      config,
      stderr,
      timeout,
    };

    child.on('error', (error) => {
      timeout.clear();
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ runId, error: message }, 'Shell spawn error');
      publishError(options, runId, 'spawn-error', { stderrTail: message });
      resolve({
        status: 'error',
        runId,
        startedAt,
        endedAt: new Date().toISOString(),
        renderedPrompt: options.prompt,
        error: `Shell spawn failed: ${message}`,
      });
    });

    child.on('close', (code, signal) => {
      timeout.clear();
      resolve(resolveExit(context, code, signal));
    });
  });
}
