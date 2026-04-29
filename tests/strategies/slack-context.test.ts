import { describe, it, expect } from 'vitest';

import { extractWebhookContext } from '../../src/strategies/context';
import { makeProvider } from '../helpers/make-provider';

describe('slack context strategy', () => {
  const slackProvider = makeProvider();

  it('should extract message timestamp as id', () => {
    const payload = {
      event: { ts: '1712345678.123456', channel: 'C08V6MV0VNV', blocks: [] },
    };
    const context = extractWebhookContext(slackProvider, payload);
    expect(context.id).toBe('1712345678.123456');
  });

  it('should extract first block text as title (truncated to 80 chars)', () => {
    const longText = 'A'.repeat(100);
    const payload = {
      event: {
        ts: '1712345678.123456',
        channel: 'C08V6MV0VNV',
        blocks: [{ text: { text: longText } }],
      },
    };
    const context = extractWebhookContext(slackProvider, payload);
    expect(context.title).toBe('A'.repeat(80));
  });

  it.each([
    { channel: 'C08V6MV0VNV', expected: 'development' },
    { channel: 'C08UWMQJFBN', expected: 'testing' },
    { channel: 'C08UVJDJZTL', expected: 'production' },
    { channel: 'C00000000', expected: 'unknown' },
  ])('should map channel $channel to $expected environment', ({ channel, expected }) => {
    const payload = { event: { ts: '1.0', channel, blocks: [] } };
    const context = extractWebhookContext(slackProvider, payload);
    expect(context.status).toBe(expected);
  });

  it('should set source to slack', () => {
    const payload = { event: { ts: '1.0', channel: 'C08V6MV0VNV', blocks: [] } };
    const context = extractWebhookContext(slackProvider, payload);
    expect(context.source).toBe('slack');
  });

  it('should return ? for missing fields', () => {
    const context = extractWebhookContext(slackProvider, {});
    expect(context.id).toBe('?');
    expect(context.title).toBe('?');
    expect(context.status).toBe('unknown');
    expect(context.source).toBe('slack');
  });
});
