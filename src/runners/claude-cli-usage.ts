/**
 * Shared usage extractor for the claude-cli stream-json `result` event.
 *
 * Both the per-event-spawn runner (`claude-cli.runner.ts`) and the
 * session-aware path (`claude-cli-session-mode.ts`) need the same shape
 * of token-usage breakdown so operators can correlate cache effectiveness
 * across modes. Lifting the extractor out of session-mode (where it
 * lived inline as `extractTurnUsage`) means the function is unit-testable
 * and pulls into the regular coverage budget — both of its callers are
 * coverage-excluded files (subprocess + Redis orchestration), so a
 * helper colocated with either of them would never get measured.
 *
 * Pure function: takes a parsed StreamEvent and returns either a
 * normalized usage record or null. Returns null when the event isn't a
 * result event, when its `usage` field is missing/wrong-typed, or when
 * the usage object is empty. Individual numeric fields default to 0
 * when missing/non-numeric — matches Anthropic's documented behavior
 * where omitted fields imply zero rather than "unknown."
 */
import type { StreamEvent } from './claude-cli-stream-parser';

export interface UsageStats {
  /** Non-cached input tokens billed at the full input rate. */
  readonly inputTokens: number;
  /** Tokens read from a previously-warmed prompt cache (~10% of input rate). */
  readonly cacheReadTokens: number;
  /** Tokens written to the prompt cache on this run (~125% of input rate). */
  readonly cacheCreationTokens: number;
  /** Output tokens from the model. */
  readonly outputTokens: number;
  /** Sum of input + cacheRead + cacheCreation — total context-window pressure. */
  readonly contextTokens: number;
  /** Number of model turns invoked during this run. */
  readonly numTurns: number;
  /** Total cost in USD as reported by the CLI (`total_cost_usd`). */
  readonly costUsd: number;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  return typeof record[key] === 'number' ? (record[key] as number) : 0;
}

/**
 * Extract usage stats from a stream-json `result` event.
 *
 * Returns null when:
 *  - the event's `type` is not `'result'`
 *  - the event has no `usage` object (or it's null / wrong-typed)
 *
 * Note: an empty usage object (`{}`) is still treated as a valid result —
 * all fields coerce to 0, the caller still gets a record they can log.
 * This matches the existing session-mode behavior.
 */
export function extractUsageFromResultEvent(event: StreamEvent): UsageStats | null {
  if (event.type !== 'result') return null;
  const raw = event as Record<string, unknown>;
  const usage = raw['usage'];
  if (usage === null || usage === undefined || typeof usage !== 'object') {
    return null;
  }
  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = readNumber(usageRecord, 'input_tokens');
  const cacheReadTokens = readNumber(usageRecord, 'cache_read_input_tokens');
  const cacheCreationTokens = readNumber(usageRecord, 'cache_creation_input_tokens');
  const outputTokens = readNumber(usageRecord, 'output_tokens');
  const turnCount = typeof raw['num_turns'] === 'number' ? (raw['num_turns'] as number) : 0;
  const costUsd = typeof raw['total_cost_usd'] === 'number' ? (raw['total_cost_usd'] as number) : 0;
  return {
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    contextTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
    numTurns: turnCount,
    costUsd,
  };
}
