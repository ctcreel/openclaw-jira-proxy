import { describe, it, expect } from 'vitest';

import { evaluateCondition } from '../../../src/strategies/routing/condition';
import {
  buildChannelIdToNameMap,
  enrichSlackPayload,
} from '../../../src/strategies/transport/slack-payload';

describe('buildChannelIdToNameMap', () => {
  it('returns an empty map when channelMap is undefined', () => {
    const inverse = buildChannelIdToNameMap(undefined);
    expect(inverse.size).toBe(0);
  });

  it('inverts a name → id mapping into id → name', () => {
    const inverse = buildChannelIdToNameMap({ ops: 'C123', alerts: 'C456' });
    expect(inverse.get('C123')).toBe('ops');
    expect(inverse.get('C456')).toBe('alerts');
    expect(inverse.size).toBe(2);
  });

  it('handles two names colliding on the same id (last wins)', () => {
    // Operationally rare — two friendly names pointing at the same channel —
    // but worth pinning the behavior so a future config doesn't surprise us.
    const inverse = buildChannelIdToNameMap({ ops: 'C123', operations: 'C123' });
    expect(inverse.size).toBe(1);
    expect(inverse.get('C123')).toBe('operations');
  });
});

describe('enrichSlackPayload', () => {
  const inverse = buildChannelIdToNameMap({ ops: 'C123' });

  function slackEvent(
    overrides: Partial<{ token: string; channel: string; ts: string; extra: Record<string, unknown> }> = {},
  ): { token?: string; event: Record<string, unknown> } {
    const { token = 'xoxb', channel = 'C123', ts = '1.1', extra = {} } = overrides;
    return { ...(token ? { token } : {}), event: { type: 'message', ts, channel, ...extra } };
  }

  it('injects event.channel_name when the channel id matches', () => {
    const enriched = enrichSlackPayload(slackEvent(), inverse) as {
      event: { channel: string; channel_name?: string };
    };
    expect(enriched.event.channel_name).toBe('ops');
    expect(enriched.event.channel).toBe('C123');
  });

  it('does NOT mutate the input payload', () => {
    const payload = slackEvent();
    const before = JSON.stringify(payload);
    enrichSlackPayload(payload, inverse);
    expect(JSON.stringify(payload)).toBe(before);
    expect(payload.event).not.toHaveProperty('channel_name');
  });

  it('returns the same reference when the channel id has no mapping', () => {
    const payload = slackEvent({ channel: 'C999' });
    expect(enrichSlackPayload(payload, inverse)).toBe(payload);
  });

  it('returns the same reference when channelIdToName is empty', () => {
    const payload = { event: { type: 'message', channel: 'C123' } };
    const empty = buildChannelIdToNameMap(undefined);
    expect(enrichSlackPayload(payload, empty)).toBe(payload);
  });

  it('returns the same reference when payload has no event', () => {
    const payload = { token: 'xoxb', team_id: 'T1' };
    expect(enrichSlackPayload(payload, inverse)).toBe(payload);
  });

  it('returns the same reference when event has no channel', () => {
    const payload = { event: { type: 'message', ts: '1.1' } };
    expect(enrichSlackPayload(payload, inverse)).toBe(payload);
  });

  it('returns the same reference when event.channel is not a string', () => {
    const payload = { event: { type: 'message', channel: 123 } };
    expect(enrichSlackPayload(payload, inverse)).toBe(payload);
  });

  it('returns the same reference when payload is not an object', () => {
    expect(enrichSlackPayload(null, inverse)).toBe(null);
    expect(enrichSlackPayload(undefined, inverse)).toBe(undefined);
    expect(enrichSlackPayload('not-an-object', inverse)).toBe('not-an-object');
  });

  it('produces a payload that routing can match by event.channel_name', () => {
    const enriched = enrichSlackPayload(slackEvent(), inverse);
    const matched = evaluateCondition(enriched, {
      equals: { field: 'event.channel_name', value: 'ops' },
    });
    expect(matched).toBe(true);
  });

  it('preserves siblings on the event object when enriching', () => {
    const payload = slackEvent({ extra: { user: 'U1', blocks: [{ text: 'hi' }] } });
    (payload as Record<string, unknown>).team_id = 'T1';
    const enriched = enrichSlackPayload(payload, inverse) as {
      token: string;
      team_id: string;
      event: { type: string; ts: string; user: string; blocks: unknown; channel_name: string };
    };
    expect(enriched.token).toBe('xoxb');
    expect(enriched.team_id).toBe('T1');
    expect(enriched.event.user).toBe('U1');
    expect(enriched.event.blocks).toEqual([{ text: 'hi' }]);
    expect(enriched.event.channel_name).toBe('ops');
  });
});
