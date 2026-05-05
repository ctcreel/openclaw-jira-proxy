import { z } from 'zod';

import { getLogger } from '../lib/logging';
import { getEventBus } from '../services/event-bus.service';

const logger = getLogger('runner:claude-cli:stream');

/**
 * Claude CLI stream-json event shape. The CLI emits one JSON object per
 * line; we care about two of the many `type` values — `assistant` for
 * tool calls and text, `result` for the final summary. The schema is
 * deliberately loose: every field beyond `type` is optional because the
 * CLI's stream format is not versioned.
 */
export const StreamEventSchema = z
  .object({
    type: z.string().optional(),
    message: z
      .object({
        content: z
          .array(
            z.object({
              type: z.string().optional(),
              text: z.string().optional(),
              name: z.string().optional(),
              input: z.unknown().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    num_turns: z.number().optional(),
    total_cost_usd: z.number().optional(),
  })
  .passthrough();

export type StreamEvent = z.infer<typeof StreamEventSchema>;

type ContentBlock = NonNullable<NonNullable<StreamEvent['message']>['content']>[number];

function emitTextBlock(
  runId: string,
  traceId: string | undefined,
  jobId: string | undefined,
  text: string,
  timestamp: number,
): void {
  const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
  logger.info({ runId, event: 'assistant_text' }, preview);
  if (traceId && jobId) {
    getEventBus().publish({
      type: 'runner.assistant_text',
      timestamp,
      traceId,
      jobId,
      runId,
      text,
    });
  }
}

function emitToolUseBlock(
  runId: string,
  traceId: string | undefined,
  jobId: string | undefined,
  block: ContentBlock,
  timestamp: number,
): void {
  logger.info({ runId, event: 'tool_call', tool: block.name }, `Tool: ${block.name ?? ''}`);
  if (traceId && jobId) {
    getEventBus().publish({
      type: 'runner.tool_call',
      timestamp,
      traceId,
      jobId,
      runId,
      tool: String(block.name ?? ''),
      args: block.input,
    });
  }
}

function emitAssistantEvents(
  runId: string,
  traceId: string | undefined,
  jobId: string | undefined,
  event: StreamEvent,
): void {
  const content = event.message?.content;
  if (!content) return;
  const timestamp = Date.now();

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      emitTextBlock(runId, traceId, jobId, block.text, timestamp);
    } else if (block.type === 'tool_use') {
      emitToolUseBlock(runId, traceId, jobId, block, timestamp);
    }
  }
}

function emitResultEvent(
  runId: string,
  traceId: string | undefined,
  jobId: string | undefined,
  event: StreamEvent,
): void {
  logger.info(
    { runId, event: 'result', turns: event.num_turns, cost: event.total_cost_usd },
    `Run finished — ${event.num_turns ?? 0} turns, $${event.total_cost_usd ?? 0}`,
  );
  if (traceId && jobId) {
    getEventBus().publish({
      type: 'runner.result',
      timestamp: Date.now(),
      traceId,
      jobId,
      runId,
      turns: Number(event.num_turns ?? 0),
      costUsd: Number(event.total_cost_usd ?? 0),
    });
  }
}

export function emitStreamEvent(
  runId: string,
  traceId: string | undefined,
  jobId: string | undefined,
  event: StreamEvent,
): void {
  if (event.type === 'assistant') {
    emitAssistantEvents(runId, traceId, jobId, event);
  } else if (event.type === 'result') {
    emitResultEvent(runId, traceId, jobId, event);
  }
}

/**
 * Detect the Claude Code CLI's subscription-limit message in an assistant
 * text block and parse the reset time.
 *
 * Format observed in production: `You've hit your limit · resets 6:40pm (UTC)`.
 * The CLI emits this as a normal assistant text event then exits with code 1
 * — there is no stderr signal. Returning a typed result lets the runner
 * surface it as `RunResult.status === 'quota_exceeded'` instead of a
 * generic error, so the worker can pause-and-hold instead of burning
 * five retries on the same wall.
 *
 * Returns the wall-clock millis when the reset is expected, or null when
 * the text is not a limit message. Reset times are interpreted in UTC; if
 * the parsed time is in the past relative to `now`, it's interpreted as
 * tomorrow (handles a limit hit at 11pm UTC that resets at 1am UTC).
 */
export function parseQuotaLimitMessage(
  text: string,
  now: Date = new Date(),
): { resetAt: number } | null {
  // Anchor on the unique "hit your limit" phrase to avoid false positives
  // from agent text that quotes the message. The em-dash variant uses U+00B7
  // ("·") in the production output; tolerate both forms.
  const limitRegex =
    /you'?ve hit your limit\s*[·\-—]\s*resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(utc\)/i;
  const match = limitRegex.exec(text);
  if (!match) return null;

  const hourRaw = Number(match[1]);
  const minuteRaw = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]!.toLowerCase();
  if (!Number.isFinite(hourRaw) || !Number.isFinite(minuteRaw)) return null;
  if (hourRaw < 1 || hourRaw > 12 || minuteRaw < 0 || minuteRaw > 59) return null;

  let hour24 = hourRaw % 12;
  if (meridiem === 'pm') hour24 += 12;

  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour24, minuteRaw, 0, 0),
  );
  // Handle wrap-around: if the parsed reset is at-or-before now (e.g. limit
  // hit at 11:30pm with reset at 1:00am), advance to the next day.
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return { resetAt: reset.getTime() };
}

export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = StreamEventSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
