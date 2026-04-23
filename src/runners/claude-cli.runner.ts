import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { getLogger } from '../lib/logging';
import type { AgentRunner, RunOptions, RunResult, ClaudeCliRunnerConfig } from './types';
import { emitStreamEvent, parseStreamLine } from './claude-cli-stream-parser';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const KILL_GRACE_MS = 5_000;

const logger = getLogger('runner:claude-cli');

type CliProcess = ChildProcessByStdio<null, Readable, Readable>;

function buildCliArgs(options: RunOptions, systemPrompt: string | undefined): string[] {
  const args = [
    '-p',
    options.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    '150',
    '--dangerously-skip-permissions',
  ];
  if (options.model) {
    args.push('--model', options.model);
  }
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }
  return args;
}

function scheduleForceKill(
  child: CliProcess,
  timeoutMs: number,
): { clear: () => void; didTimeOut: () => boolean } {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);
  }, timeoutMs);
  return {
    clear: () => clearTimeout(timer),
    didTimeOut: () => timedOut,
  };
}

function installStreamParser(child: CliProcess, runId: string, options: RunOptions): void {
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseStreamLine(line);
      if (event) {
        emitStreamEvent(runId, options.traceId, options.jobId, event);
      }
    }
  });
}

function buildCloseHandler(
  runId: string,
  startedAt: string,
  options: RunOptions,
  state: { stderr: string; didTimeOut: () => boolean },
  resolve: (r: RunResult) => void,
): (code: number | null) => void {
  return (code) => {
    const endedAt = new Date().toISOString();
    if (state.didTimeOut()) {
      resolve({
        status: 'timeout',
        runId,
        startedAt,
        endedAt,
        renderedPrompt: options.prompt,
        error: `Claude CLI timed out after ${options.timeoutMs}ms`,
      });
      return;
    }
    if (code !== 0) {
      const errorMessage = state.stderr.trim() || `Claude CLI exited with code ${code}`;
      logger.error({ runId, code, stderr: state.stderr.slice(0, 500) }, 'Claude CLI failed');
      resolve({
        status: 'error',
        runId,
        error: errorMessage,
        startedAt,
        endedAt,
        renderedPrompt: options.prompt,
      });
      return;
    }
    logger.info({ runId }, 'Claude CLI completed');
    resolve({ status: 'ok', runId, startedAt, endedAt, renderedPrompt: options.prompt });
  };
}

/**
 * Spawns a `claude -p` subprocess for each run.
 * Parses stream-json output for structured results.
 */
export class ClaudeCliRunner implements AgentRunner {
  readonly name = 'claude-cli';
  private readonly workDirectory: string;
  private readonly binary: string;
  private readonly systemPrompt: string | undefined;

  constructor(config: ClaudeCliRunnerConfig) {
    this.workDirectory = config.workDirectory;
    this.binary = config.binary ?? 'claude';
    this.systemPrompt = config.systemPrompt;
  }

  async close(): Promise<void> {
    // No resources to clean up — `claude -p` is spawned per run.
  }

  isHealthy(): boolean {
    // Env-var injected token (Mac plist path) OR file-based credentials
    // written by `claude login` (Linux / EC2 path). Either is authoritative.
    return process.env['CLAUDE_CODE_OAUTH_TOKEN'] !== undefined || existsSync(CREDENTIALS_PATH);
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const runId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const args = buildCliArgs(options, this.systemPrompt);

    logger.info(
      { runId, binary: this.binary, workDirectory: this.workDirectory },
      'Spawning Claude CLI',
    );

    return runClaudeCliSubprocess(this.binary, args, this.workDirectory, runId, startedAt, options);
  }
}

function runClaudeCliSubprocess(
  binary: string,
  args: string[],
  workDirectory: string,
  runId: string,
  startedAt: string,
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(binary, args, {
      cwd: workDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    }) as CliProcess;

    const state = { stderr: '' };
    const timeout = scheduleForceKill(child, options.timeoutMs);

    installStreamParser(child, runId, options);

    child.stderr.on('data', (chunk: Buffer) => {
      state.stderr += chunk.toString();
    });

    child.on('close', (code) => {
      timeout.clear();
      buildCloseHandler(
        runId,
        startedAt,
        options,
        { stderr: state.stderr, didTimeOut: timeout.didTimeOut },
        resolve,
      )(code);
    });

    child.on('error', (error) => {
      timeout.clear();
      logger.error({ runId, error: error.message }, 'Claude CLI spawn error');
      resolve({
        status: 'error',
        runId,
        error: error.message,
        startedAt,
        endedAt: new Date().toISOString(),
        renderedPrompt: options.prompt,
      });
    });
  });
}
