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
