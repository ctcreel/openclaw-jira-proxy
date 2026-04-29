import { describe, expect, it } from 'vitest';

import type { ProviderConfig } from '../../../src/config';
import { slackSessionKeyStrategy } from '../../../src/strategies/session-key/slack';

const provider = {
  name: 'slack-winston',
  transport: 'slack-socket',
  appTokenSecret: 'app',
  botTokenSecret: 'bot',
} as unknown as ProviderConfig;

describe('slackSessionKeyStrategy.extract', () => {
  it('returns channel for a true DM (channel_type=im)', () => {
    const payload = {
      event: { channel: 'D123', channel_type: 'im', ts: '1.0', type: 'message' },
    };
    expect(slackSessionKeyStrategy.extract(payload, provider)).toBe('D123');
  });

  it('returns channel for an assistant_thread starter (envelope present)', () => {
    const payload = {
      event: {
        channel: 'C456',
        channel_type: 'group',
        ts: '2.0',
        type: 'message',
        assistant_thread: { action_token: 'tok' },
      },
    };
    expect(slackSessionKeyStrategy.extract(payload, provider)).toBe('C456');
  });

  it('returns channel for an assistant_thread continuation (group + thread_ts, no envelope)', () => {
    const payload = {
      event: {
        channel: 'C456',
        channel_type: 'group',
        ts: '3.0',
        thread_ts: '2.0',
        type: 'message',
      },
    };
    expect(slackSessionKeyStrategy.extract(payload, provider)).toBe('C456');
  });

  it('returns channel:ts for an app_mention in a regular channel (no thread)', () => {
    const payload = {
      event: {
        channel: 'C789',
        channel_type: 'channel',
        ts: '4.0',
        type: 'app_mention',
      },
    };
    expect(slackSessionKeyStrategy.extract(payload, provider)).toBe('C789:4.0');
  });

  it('returns channel:thread_ts for an app_mention inside a thread', () => {
    const payload = {
      event: {
        channel: 'C789',
        channel_type: 'channel',
        ts: '5.0',
        thread_ts: '4.0',
        type: 'app_mention',
      },
    };
    expect(slackSessionKeyStrategy.extract(payload, provider)).toBe('C789:4.0');
  });

  it('returns channel:thread_ts for a thread reply in a regular channel', () => {
    const payload = {
      event: {
        channel: 'C789',
        channel_type: 'channel',
        ts: '6.0',
        thread_ts: '4.0',
        type: 'message',
      },
    };
    expect(slackSessionKeyStrategy.extract(payload, provider)).toBe('C789:4.0');
  });

  it('returns null for a top-level message in a regular channel without mention/thread', () => {
    const payload = {
      event: { channel: 'C789', channel_type: 'channel', ts: '7.0', type: 'message' },
    };
    expect(slackSessionKeyStrategy.extract(payload, provider)).toBeNull();
  });

  it('returns null for unrecognized event types (reactions, joins, etc.)', () => {
    expect(
      slackSessionKeyStrategy.extract(
        { event: { type: 'reaction_added', channel: 'C789' } },
        provider,
      ),
    ).toBeNull();
    expect(
      slackSessionKeyStrategy.extract(
        { event: { type: 'channel_join', channel: 'C789', channel_type: 'channel' } },
        provider,
      ),
    ).toBeNull();
  });

  it('returns null when channel is missing', () => {
    expect(
      slackSessionKeyStrategy.extract({ event: { channel_type: 'im', type: 'message' } }, provider),
    ).toBeNull();
  });

  it('returns null when payload is malformed', () => {
    expect(slackSessionKeyStrategy.extract(null, provider)).toBeNull();
    expect(slackSessionKeyStrategy.extract('not-an-object', provider)).toBeNull();
    expect(slackSessionKeyStrategy.extract({}, provider)).toBeNull();
    expect(slackSessionKeyStrategy.extract({ event: null }, provider)).toBeNull();
  });

  it('exposes its name as "slack"', () => {
    expect(slackSessionKeyStrategy.name).toBe('slack');
  });
});
