/**
 * Session-aware claude-cli orchestration.
 *
 * Acquires a warm subprocess from the SessionPool (or spawns/resumes if cold),
 * sends a single user turn, awaits the result-stream event, returns. The pool
 * owns subprocess lifecycle; this file owns observability for the single turn
 * (event emission to the bus + per-turn token-usage logging) plus the turn
 * timeout.
 *
 * Excluded from line coverage in vitest.config.ts — same reason as
 * session-pool.service.ts and claude-cli-stream-parser.ts: subprocess +
 * Redis orchestration that's exercised end-to-end at integration time
 * (Slack chat in production), not at unit-line granularity. The
 * SessionPool class itself has 11 dedicated unit tests covering its
 * lifecycle; this file is the thin "deliver one turn" adapter on top.
 */

import { getLogger } from '../lib/logging';
import { getSessionPool } from '../services/session-pool.service';
import type { RunResult, SessionRunOptions } from './types';
import { emitStreamEvent } from './claude-cli-stream-parser';
import type { StreamEvent } from './claude-cli-stream-parser';
import { extractUsageFromResultEvent, type UsageStats } from './claude-cli-usage';

const TIMEOUT_SENTINEL = '__session_turn_timeout__';
const logger = getLogger('runner:claude-cli-session');

function createTimeoutRejection(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(TIMEOUT_SENTINEL)), ms);
  });
}

function emitTurnEventsToBus(
  events: readonly StreamEvent[],
  runId: string,
  traceId: string | undefined,
  jobId: string | undefined,
): void {
  for (const event of events) {
    emitStreamEvent(runId, traceId, jobId, event);
  }
}

/**
 * Extract per-turn token usage from the events array for observability.
 * Thin wrapper around the shared `extractUsageFromResultEvent` helper —
 * locates the result event in the captured turn stream and delegates to
 * the shared extractor. Lets us track context-window pressure (sum of
 * input + cache_read + cache_creation) over time per session, so the
 * eventual decision about auto-compaction cadence is grounded in real
 * numbers rather than guesswork.
 *
 * Returns null when no result event is found or it lacks usage.
 */
function extractTurnUsage(events: readonly StreamEvent[]): UsageStats | null {
  const result = events.find((event) => event.type === 'result');
  if (result === undefined) return null;
  return extractUsageFromResultEvent(result);
}

/**
 * Run a single session-aware turn against the SessionPool.
 *
 * Caller (the ClaudeCliRunner class) provides workDirectory + binary; the
 * SessionPool decides whether to spawn fresh, resume from Redis, or reuse
 * a warm subprocess.
 */
export async function runSessionTurn(
  workDirectory: string,
  binary: string,
  options: SessionRunOptions,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const runId = `cli-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pool = getSessionPool();

  logger.info(
    {
      runId,
      provider: options.providerName,
      sessionKey: options.sessionKey,
      strategy: options.strategy.name,
    },
    'Acquiring session subprocess',
  );

  let handle;
  try {
    handle = await pool.acquire(
      {
        providerName: options.providerName,
        key: options.sessionKey,
        providerConfig: options.providerConfig,
        sessionConfig: options.sessionConfig,
        workDirectory,
        binary,
        env: options.env,
        model: options.model,
      },
      options.strategy,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ runId, error: message }, 'Session acquire failed');
    return {
      status: 'error',
      runId,
      error: message,
      startedAt,
      endedAt: new Date().toISOString(),
      renderedPrompt: options.userMessage,
    };
  }

  // Brand-new sessions need the full template as their first user message;
  // warm and resume paths just get the new event's payload (the prior
  // template is already in the session JSONL).
  const turnPayload =
    handle.acquirePath === 'fresh' ? options.firstTurnPrompt : options.userMessage;

  try {
    const events = await Promise.race([
      handle.runTurn(turnPayload),
      createTimeoutRejection(options.timeoutMs),
    ]);
    emitTurnEventsToBus(events, runId, options.traceId, options.jobId);
    const usage = extractTurnUsage(events);
    logger.info(
      {
        runId,
        sessionId: handle.sessionId,
        eventCount: events.length,
        ...(usage ?? {}),
      },
      'Session turn completed',
    );
    return {
      status: 'ok',
      runId,
      startedAt,
      endedAt: new Date().toISOString(),
      renderedPrompt: turnPayload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message === TIMEOUT_SENTINEL;
    logger.error({ runId, error: isTimeout ? 'turn timed out' : message }, 'Session turn failed');
    return {
      status: isTimeout ? 'timeout' : 'error',
      runId,
      error: isTimeout ? `Session turn timed out after ${options.timeoutMs}ms` : message,
      startedAt,
      endedAt: new Date().toISOString(),
      renderedPrompt: turnPayload,
    };
  }
}
