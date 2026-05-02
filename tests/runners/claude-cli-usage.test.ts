import { describe, it, expect } from 'vitest';

import { extractUsageFromResultEvent } from '../../src/runners/claude-cli-usage';
import type { StreamEvent } from '../../src/runners/claude-cli-stream-parser';

function buildResultEvent(overrides: Partial<Record<string, unknown>> = {}): StreamEvent {
  return {
    type: 'result',
    num_turns: 1,
    total_cost_usd: 0.005896,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 56713,
      output_tokens: 43,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    },
    ...overrides,
  } as StreamEvent;
}

describe('extractUsageFromResultEvent', () => {
  it('returns the full breakdown for a well-formed result event', () => {
    const usage = extractUsageFromResultEvent(buildResultEvent());

    expect(usage).toEqual({
      inputTokens: 10,
      cacheReadTokens: 56713,
      cacheCreationTokens: 0,
      outputTokens: 43,
      contextTokens: 56723, // 10 + 56713 + 0
      numTurns: 1,
      costUsd: 0.005896,
    });
  });

  it('returns null for non-result events', () => {
    const assistant: StreamEvent = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    } as StreamEvent;
    expect(extractUsageFromResultEvent(assistant)).toBeNull();
  });

  it('returns null when type is missing', () => {
    const noType = { usage: { input_tokens: 1 } } as StreamEvent;
    expect(extractUsageFromResultEvent(noType)).toBeNull();
  });

  it('returns null when usage is missing on a result event', () => {
    const event = { type: 'result', num_turns: 1 } as StreamEvent;
    expect(extractUsageFromResultEvent(event)).toBeNull();
  });

  it('returns null when usage is null', () => {
    const event = buildResultEvent({ usage: null });
    expect(extractUsageFromResultEvent(event)).toBeNull();
  });

  it('returns null when usage is wrong-typed (not an object)', () => {
    const event = buildResultEvent({ usage: 'not-an-object' });
    expect(extractUsageFromResultEvent(event)).toBeNull();
  });

  it('coerces missing numeric fields in usage to 0 individually', () => {
    const event = buildResultEvent({ usage: { input_tokens: 100 } });
    const usage = extractUsageFromResultEvent(event);

    expect(usage).toEqual({
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      contextTokens: 100,
      numTurns: 1,
      costUsd: 0.005896,
    });
  });

  it('coerces non-numeric individual fields to 0', () => {
    const event = buildResultEvent({
      usage: {
        input_tokens: 'not-a-number',
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: null,
        output_tokens: undefined,
      },
    });
    const usage = extractUsageFromResultEvent(event);

    expect(usage).toEqual({
      inputTokens: 0,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
      outputTokens: 0,
      contextTokens: 50,
      numTurns: 1,
      costUsd: 0.005896,
    });
  });

  it('coerces missing num_turns and total_cost_usd to 0', () => {
    const event: StreamEvent = {
      type: 'result',
      usage: { input_tokens: 1 },
    } as StreamEvent;
    const usage = extractUsageFromResultEvent(event);

    expect(usage?.numTurns).toBe(0);
    expect(usage?.costUsd).toBe(0);
  });

  it('computes contextTokens as input + cacheRead + cacheCreation', () => {
    const event = buildResultEvent({
      usage: {
        input_tokens: 200,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
        output_tokens: 999,
      },
    });
    const usage = extractUsageFromResultEvent(event);

    expect(usage?.contextTokens).toBe(1250); // does NOT include outputTokens
  });

  it('treats an empty usage object as a valid result with all zeros', () => {
    // Existing session-mode behavior — preserves the contract that callers
    // can always log a record when type === 'result' and usage is an object.
    const event = buildResultEvent({ usage: {} });
    const usage = extractUsageFromResultEvent(event);

    expect(usage).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      numTurns: 1,
      costUsd: 0.005896,
    });
  });
});
