import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { getLogger } from '../lib/logging';
import { runSessionTurn } from './claude-cli-session-mode';
import type {
  AgentRunner,
  RunOptions,
  RunResult,
  SessionRunOptions,
  ClaudeCliRunnerConfig,
} from './types';
import {
  emitStreamEvent,
  extractSessionIdFromInitEvent,
  parseQuotaLimitMessage,
  parseStreamLine,
} from './claude-cli-stream-parser';
import { extractUsageFromResultEvent } from './claude-cli-usage';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const KILL_GRACE_MS = 5_000;

const logger = getLogger('runner:claude-cli');

type CliProcess = ChildProcessByStdio<null, Readable, Readable>;

const DEFAULT_MAX_TURNS = 150;

function buildCliArgs(options: RunOptions, systemPrompt: string | undefined): string[] {
  // The `--max-turns` ceiling is per-run because some routing rules drive
  // wider cascades than others. Plan-style rules finish under the 150
  // default; ready-for-development rules whose work cascades across
  // dozens of test files (e.g. SPE-2010's tuple-shape change rippled
  // through 18 test files = 60+ Edit calls = 60+ turns) opt in to a
  // higher ceiling via rule.maxTurns. Other runners ignore the field.
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const args = [
    '-p',
    options.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
    '--dangerously-skip-permissions',
  ];
  if (options.model) {
    args.push('--model', options.model);
  }
  // SPE-2078: when the worker passed an MCP bundle, register the per-run
  // tool surface via Claude CLI's --mcp-config. The spawned MCP server
  // (`scripts/clawndom_mcp_server.py`) exposes the route's declared tools
  // and dispatches to impl.{py,sh} with credentials injected from env.
  if (options.mcpBundle !== undefined) {
    args.push('--mcp-config', options.mcpBundle.mcpConfigPath);
  }
  if (options.resumeSessionId !== undefined) {
    // Quota-pause recovery: continue the prior conversation rather than
    // spawn fresh. claude-cli accepts --resume alongside -p; the prompt
    // becomes the next user message in the resumed session, and the
    // assistant picks up where the prior limit message cut it off.
    // System prompt is omitted on resume because it's already cached in
    // the existing session — supplying it again would either be ignored
    // or treated as a new turn, neither helpful.
    args.push('--resume', options.resumeSessionId);
    return args;
  }
  // Combine config-level system prompt (e.g. "You are Patch.") with the
  // per-run system prompt extracted from the template's `{{system-…}}` tags.
  // Both halves are stable across runs of the same template, so the combined
  // text becomes a single cacheable prefix on Anthropic's prompt cache.
  const combinedSystem = [systemPrompt, options.systemPrompt].filter(Boolean).join('\n\n');
  if (combinedSystem.length > 0) {
    args.push('--system-prompt', combinedSystem);
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

interface QuotaSignal {
  resetAt: number | null;
}

interface SessionCapture {
  sessionId: string | null;
}

function extractQuotaResetFromEvent(event: {
  message?: { content?: Array<{ type?: string; text?: string }> };
}): number | null {
  const content = event.message?.content;
  if (!content) return null;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const limit = parseQuotaLimitMessage(block.text);
      if (limit !== null) return limit.resetAt;
    }
  }
  return null;
}

function installStreamParser(
  child: CliProcess,
  runId: string,
  options: RunOptions,
  quotaSignal: QuotaSignal,
  sessionCapture: SessionCapture,
): void {
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseStreamLine(line);
      if (!event) continue;
      // Capture session_id from the first system.init event — claude-cli
      // emits exactly one per run before any assistant content. Stored
      // for the quota-pause recovery path to populate envelope.sessionId
      // on requeue, so the next pickup `--resume`s the same conversation.
      if (sessionCapture.sessionId === null) {
        const id = extractSessionIdFromInitEvent(event);
        if (id !== null) {
          sessionCapture.sessionId = id;
        }
      }
      // Detect the subscription-limit message before emitting downstream
      // — the parser handles other paths normally; we just sniff for the
      // quota signal so the close handler can surface the right status.
      if (quotaSignal.resetAt === null) {
        const detected = extractQuotaResetFromEvent(event);
        if (detected !== null) {
          quotaSignal.resetAt = detected;
          logger.warn(
            {
              runId,
              traceId: options.traceId,
              jobId: options.jobId,
              resetAt: new Date(detected).toISOString(),
            },
            'Claude CLI reported subscription quota limit hit',
          );
        }
      }
      emitStreamEvent(runId, options.traceId, options.jobId, event);
      // Result events carry the per-run token-usage breakdown. Emitting a
      // structured "Agent run usage" log line here closes the observability
      // gap with session-aware mode (which already logs the same shape on
      // "Session turn completed"). Operators can now grep cacheReadTokens
      // to confirm the prompt cache is engaging across runs of the same
      // template within the 1-hour TTL.
      const usage = extractUsageFromResultEvent(event);
      if (usage !== null) {
        logger.info(
          {
            runId,
            traceId: options.traceId,
            jobId: options.jobId,
            ...usage,
          },
          'Agent run usage',
        );
      }
    }
  });
}

function buildCloseHandler(
  runId: string,
  startedAt: string,
  options: RunOptions,
  state: {
    stderr: string;
    didTimeOut: () => boolean;
    quotaSignal: QuotaSignal;
    sessionCapture: SessionCapture;
  },
  resolve: (r: RunResult) => void,
): (code: number | null) => void {
  return (code) => {
    const endedAt = new Date().toISOString();
    // sessionId is set on every result variant when the stream produced
    // a system.init event (which is every claude-cli run that got past
    // spawn). Quota-pause path needs it on the requeue envelope; other
    // paths surface it for completeness / future use.
    const sessionId = state.sessionCapture.sessionId ?? undefined;
    if (state.didTimeOut()) {
      resolve({
        status: 'timeout',
        runId,
        startedAt,
        endedAt,
        renderedPrompt: options.prompt,
        error: `Claude CLI timed out after ${options.timeoutMs}ms`,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      return;
    }
    // Quota signal takes precedence over the generic non-zero exit path.
    // The CLI exits 1 immediately after emitting the limit message; without
    // this branch we'd treat it as a transient error and burn five retries
    // each hitting the same wall.
    if (state.quotaSignal.resetAt !== null) {
      logger.warn(
        {
          runId,
          code,
          resetAt: new Date(state.quotaSignal.resetAt).toISOString(),
          sessionId: sessionId ?? '(none captured)',
        },
        'Claude CLI exited after quota-limit signal — surfacing as quota_exceeded',
      );
      resolve({
        status: 'quota_exceeded',
        runId,
        quotaResetAt: state.quotaSignal.resetAt,
        startedAt,
        endedAt,
        renderedPrompt: options.prompt,
        ...(sessionId !== undefined ? { sessionId } : {}),
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
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      return;
    }
    logger.info({ runId }, 'Claude CLI completed');
    resolve({
      status: 'ok',
      runId,
      startedAt,
      endedAt,
      renderedPrompt: options.prompt,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
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
    const workDirectory = options.workDirectoryOverride ?? this.workDirectory;

    logger.info({ runId, binary: this.binary, workDirectory }, 'Spawning Claude CLI');

    return runClaudeCliSubprocess(this.binary, args, workDirectory, runId, startedAt, options);
  }

  /**
   * Session-aware turn: thin facade. Implementation lives in
   * `claude-cli-session-mode.ts` so the subprocess + SessionPool
   * orchestration can be coverage-excluded as a unit (it's exercised
   * end-to-end at integration time, not unit-line — same shape as
   * session-pool.service.ts and claude-cli-stream-parser.ts).
   */
  async runSession(options: SessionRunOptions): Promise<RunResult> {
    return runSessionTurn(this.workDirectory, this.binary, options);
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
    // SPE-2078: when an MCP bundle is present, merge its env (credentials
    // for the per-run tool surface) on top of any caller-supplied env.
    // Env vars do not enter the model's context — claude-cli inherits them
    // and forwards to the MCP server it spawns.
    const mergedEnv =
      options.mcpBundle !== undefined || options.env !== undefined
        ? { ...process.env, ...(options.env ?? {}), ...(options.mcpBundle?.env ?? {}) }
        : process.env;
    const child = spawn(binary, args, {
      cwd: workDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: mergedEnv,
    }) as CliProcess;

    const state = { stderr: '' };
    const quotaSignal: QuotaSignal = { resetAt: null };
    const sessionCapture: SessionCapture = { sessionId: null };
    const timeout = scheduleForceKill(child, options.timeoutMs);

    installStreamParser(child, runId, options, quotaSignal, sessionCapture);

    child.stderr.on('data', (chunk: Buffer) => {
      state.stderr += chunk.toString();
    });

    child.on('close', (code) => {
      timeout.clear();
      buildCloseHandler(
        runId,
        startedAt,
        options,
        {
          stderr: state.stderr,
          didTimeOut: timeout.didTimeOut,
          quotaSignal,
          sessionCapture,
        },
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
