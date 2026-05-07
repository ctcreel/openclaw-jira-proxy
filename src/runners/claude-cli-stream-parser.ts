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
    // claude-cli emits `system` events with `subtype: 'init'` once per
    // run as the first stream event, carrying the session_id we need to
    // capture for `--resume` on the next pickup after a quota pause.
    subtype: z.string().optional(),
    session_id: z.string().optional(),
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
 * The CLI prints the message in the host's local time zone — `(UTC)` on a
 * UTC-set host, `(America/New_York)` on a host with TZ=America/New_York,
 * etc. The CLI exits 1 immediately after; there is no stderr signal.
 * Returning a typed result lets the runner surface it as
 * `RunResult.status === 'quota_exceeded'` instead of a generic error, so
 * the worker can pause-and-hold instead of burning five retries on the
 * same wall.
 *
 * Returns the wall-clock millis when the reset is expected, or null when
 * the text is not a limit message OR the captured zone string isn't a
 * recognized IANA timezone. Reset times in the past relative to `now` are
 * interpreted as tomorrow (handles a limit hit at 11pm with reset at 1am).
 */
export function parseQuotaLimitMessage(
  text: string,
  now: Date = new Date(),
): { resetAt: number } | null {
  // Anchor to the full trimmed assistant block so the agent quoting the
  // message in normal text ("As discussed, you've hit your limit · resets
  // 6pm (UTC)…") doesn't get misclassified. claude-cli emits the limit
  // text as a standalone assistant_text payload — there's no other content
  // around it. The em-dash variant uses U+00B7 ("·") in the production
  // output; tolerate both forms. The zone group matches any non-paren run
  // so non-UTC hosts (e.g. America/New_York) parse correctly.
  const limitRegex =
    /^\s*you'?ve hit your limit\s*[·\-—]\s*resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)\s*$/i;
  const match = limitRegex.exec(text);
  if (!match) return null;

  // The regex pattern guarantees groups 1, 3, and 4 when match succeeds,
  // but TypeScript can't infer that from the regex literal — explicit
  // guard + fail-fast instead of a `!` non-null assertion (project rule).
  const hourRawGroup = match[1];
  const meridiemGroup = match[3];
  const zoneGroup = match[4];
  if (hourRawGroup === undefined || meridiemGroup === undefined || zoneGroup === undefined) {
    return null;
  }
  const hourRaw = Number(hourRawGroup);
  const minuteRaw = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = meridiemGroup.toLowerCase();
  const zone = zoneGroup.trim();
  if (!Number.isFinite(hourRaw) || !Number.isFinite(minuteRaw)) return null;
  if (hourRaw < 1 || hourRaw > 12 || minuteRaw < 0 || minuteRaw > 59) return null;

  let hour24 = hourRaw % 12;
  if (meridiem === 'pm') hour24 += 12;

  const offsetAtNow = getTimeZoneOffsetMs(zone, now);
  if (offsetAtNow === null) return null;

  // Build the candidate reset on the calendar day in `zone` that contains
  // `now`. `now + offset` re-encoded as UTC components is the wall clock in
  // the zone, so reading `getUTC*` off that gives the zoned y/m/d.
  const zonedNow = new Date(now.getTime() + offsetAtNow);
  const wallAsUTC = Date.UTC(
    zonedNow.getUTCFullYear(),
    zonedNow.getUTCMonth(),
    zonedNow.getUTCDate(),
    hour24,
    minuteRaw,
    0,
    0,
  );
  // Re-resolve the offset at the candidate instant — handles DST refinements
  // when the limit was hit just before a transition and reset falls after.
  const offsetAtCandidate = getTimeZoneOffsetMs(zone, new Date(wallAsUTC - offsetAtNow));
  if (offsetAtCandidate === null) return null;
  let resetMs = wallAsUTC - offsetAtCandidate;
  if (resetMs <= now.getTime()) {
    resetMs += 24 * 60 * 60 * 1000;
  }
  return { resetAt: resetMs };
}

/**
 * UTC-offset (in millis) for `zone` at `instant`, such that
 * `wallClockAsUTC - offset === instant.getTime()`. Returns null when the
 * zone string isn't a recognized IANA timezone — the upstream caller
 * surfaces this as "no resetAt", letting the worker fall back to its
 * minimum pause-and-hold floor instead of misinterpreting a UTC instant.
 */
function getTimeZoneOffsetMs(zone: string, instant: Date): number | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return null;
  }
  const parts = formatter.formatToParts(instant);
  const partValue = (type: string): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const year = Number(partValue('year'));
  const month = Number(partValue('month'));
  const day = Number(partValue('day'));
  // Some Intl backends emit "24" for midnight when hour12 is false; normalize.
  const hour = Number(partValue('hour')) % 24;
  const minute = Number(partValue('minute'));
  const second = Number(partValue('second'));
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second) - instant.getTime();
}

/**
 * Pull the `session_id` out of claude-cli's first stream event of a run.
 * The CLI emits `{type: 'system', subtype: 'init', session_id: '...'}`
 * once per run before any assistant content. The session_id is the same
 * value `--resume <id>` accepts, so capturing it here lets a quota-paused
 * run be resumed on the next pickup instead of replanning from scratch.
 *
 * Returns null for any other event shape.
 */
export function extractSessionIdFromInitEvent(event: StreamEvent): string | null {
  if (event.type !== 'system' || event.subtype !== 'init') return null;
  return event.session_id ?? null;
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
