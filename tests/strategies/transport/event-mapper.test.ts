import { describe, it, expect } from 'vitest';

import { mapSocketModeEnvelopeToWebhookPayload } from '../../../src/strategies/transport/event-mapper';

describe('mapSocketModeEnvelopeToWebhookPayload', () => {
  it('unwraps the payload field of an events_api envelope', () => {
    const envelope = {
      envelope_id: 'env-1',
      type: 'events_api',
      payload: {
        token: 'xoxb-fake',
        team_id: 'T1',
        event: { type: 'message', ts: '1.1', channel: 'C1' },
      },
    };
    expect(mapSocketModeEnvelopeToWebhookPayload(envelope)).toEqual(envelope.payload);
  });

  it('returns the input unchanged when payload is missing', () => {
    const envelope = { envelope_id: 'env-1', type: 'slash_commands' };
    expect(mapSocketModeEnvelopeToWebhookPayload(envelope)).toBe(envelope);
  });

  it('returns the input unchanged when payload is not an object', () => {
    const envelope = { type: 'events_api', payload: 'oops' };
    expect(mapSocketModeEnvelopeToWebhookPayload(envelope)).toBe(envelope);
  });

  it('returns the input unchanged for null', () => {
    expect(mapSocketModeEnvelopeToWebhookPayload(null)).toBeNull();
  });

  it('returns the input unchanged for non-objects', () => {
    expect(mapSocketModeEnvelopeToWebhookPayload('hello')).toBe('hello');
    expect(mapSocketModeEnvelopeToWebhookPayload(42)).toBe(42);
    expect(mapSocketModeEnvelopeToWebhookPayload(undefined)).toBeUndefined();
  });
});
