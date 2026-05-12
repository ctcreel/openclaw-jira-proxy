import { describe, it, expect } from 'vitest';

import { decodePubsubEnvelope } from '../../../src/strategies/transport/pubsub-envelope';

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');
}

describe('decodePubsubEnvelope', () => {
  it('unwraps a well-formed Pub/Sub envelope into the inner JSON payload', () => {
    const inner = { emailAddress: 'heather@talkatlanta.info', historyId: '12345' };
    const result = decodePubsubEnvelope({
      message: {
        data: base64Json(inner),
        messageId: 'msg-1',
        publishTime: '2026-05-12T17:00:00Z',
      },
      subscription: 'projects/talk/subscriptions/gog-gmail-watch-sub',
    });
    expect(result.unwrapped).toBe(true);
    expect(result.payload).toEqual(inner);
    expect(result.messageId).toBe('msg-1');
    expect(result.subscription).toBe('projects/talk/subscriptions/gog-gmail-watch-sub');
  });

  it('surfaces the decoded string when message.data is not JSON', () => {
    const raw = 'just-a-plain-string';
    const result = decodePubsubEnvelope({
      message: { data: Buffer.from(raw, 'utf-8').toString('base64'), messageId: 'm' },
      subscription: 's',
    });
    expect(result.unwrapped).toBe(true);
    expect(result.payload).toBe(raw);
  });

  it('returns the input unchanged when there is no `message` key', () => {
    const arbitrary = { hello: 'world' };
    const result = decodePubsubEnvelope(arbitrary);
    expect(result.unwrapped).toBe(false);
    expect(result.payload).toBe(arbitrary);
  });

  it('returns the input unchanged when message is not an object', () => {
    const result = decodePubsubEnvelope({ message: 'not-an-object' });
    expect(result.unwrapped).toBe(false);
  });

  it('returns the input unchanged when message.data is missing', () => {
    const result = decodePubsubEnvelope({ message: { messageId: 'x' } });
    expect(result.unwrapped).toBe(false);
  });

  it('returns the input unchanged when message.data is not a string', () => {
    const result = decodePubsubEnvelope({ message: { data: 42 } });
    expect(result.unwrapped).toBe(false);
  });

  it('omits messageId and subscription when they are missing from the wrapper', () => {
    const result = decodePubsubEnvelope({
      message: { data: base64Json({ a: 1 }) },
    });
    expect(result.unwrapped).toBe(true);
    expect(result.payload).toEqual({ a: 1 });
    expect(result.messageId).toBeUndefined();
    expect(result.subscription).toBeUndefined();
  });

  it('preserves null and primitive inputs', () => {
    expect(decodePubsubEnvelope(null).unwrapped).toBe(false);
    expect(decodePubsubEnvelope(42).unwrapped).toBe(false);
    expect(decodePubsubEnvelope('plain').unwrapped).toBe(false);
  });
});
