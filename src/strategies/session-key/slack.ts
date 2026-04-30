import type { ProviderConfig } from '../../config';

import type { SessionKeyStrategy } from './types';

interface SlackEventShape {
  channel?: unknown;
  channel_type?: unknown;
  thread_ts?: unknown;
  ts?: unknown;
  type?: unknown;
  assistant_thread?: unknown;
}

interface SlackPayloadShape {
  event?: SlackEventShape;
}

/**
 * Slack session-key derivation. Different Slack contexts have different
 * "what's the same conversation" semantics:
 *
 * - **DM** (`channel_type=im`): one ongoing per-DM-channel conversation
 *   regardless of how many top-level messages exist. Key = channel id.
 * - **Assistant thread** (`assistant_thread` envelope on the starter, OR
 *   `channel_type=group` with a `thread_ts`): one ongoing conversation per
 *   assistant panel. Key = channel id.
 * - **App mention in a regular channel** (`type=app_mention`,
 *   `channel_type=channel`): each mention starts its own conversation
 *   (mentions are independent). Key = `${channel}:${thread_ts ?? ts}` so
 *   thread replies under the same mention map to the same key.
 * - **Thread reply in a regular channel** (`type=message`,
 *   `channel_type=channel` with a `thread_ts`): continues the parent
 *   mention's session. Key = `${channel}:${thread_ts}`.
 * - **Anything else** (reactions, profile changes, file uploads, etc.):
 *   not a conversational event. Returns null; worker falls back to
 *   per-event-spawn (which itself drops the event when no rule matches).
 */
export const slackSessionKeyStrategy: SessionKeyStrategy = {
  name: 'slack',
  extract(payload: unknown, _providerConfig: ProviderConfig): string | null {
    if (payload === null || typeof payload !== 'object') {
      return null;
    }
    const slackPayload = payload as SlackPayloadShape;
    const event = slackPayload.event;
    if (event === null || event === undefined || typeof event !== 'object') {
      return null;
    }

    const channel = typeof event.channel === 'string' ? event.channel : null;
    if (channel === null || channel.length === 0) {
      return null;
    }

    const channelType = typeof event.channel_type === 'string' ? event.channel_type : null;
    const eventType = typeof event.type === 'string' ? event.type : null;
    const threadTs = typeof event.thread_ts === 'string' ? event.thread_ts : null;
    const ts = typeof event.ts === 'string' ? event.ts : null;
    const hasAssistantThread =
      event.assistant_thread !== null && event.assistant_thread !== undefined;

    // DM: one conversation per DM channel, regardless of thread structure.
    if (channelType === 'im') {
      return channel;
    }

    // Assistant thread: starter has `assistant_thread`; continuations have
    // `channel_type=group` + `thread_ts`. Either way, key by channel only —
    // one conversation per assistant panel.
    if (hasAssistantThread) {
      return channel;
    }
    if (channelType === 'group' && threadTs !== null) {
      return channel;
    }

    // App mention in a regular channel: separate mentions are separate
    // conversations. Use `thread_ts ?? ts` so thread replies under the same
    // mention map to the same key as the mention itself.
    if (eventType === 'app_mention' && channelType === 'channel') {
      const conversationId = threadTs ?? ts;
      if (conversationId === null) {
        return null;
      }
      return `${channel}:${conversationId}`;
    }

    // Thread reply in a regular channel: continues the parent mention's session.
    if (eventType === 'message' && channelType === 'channel' && threadTs !== null) {
      return `${channel}:${threadTs}`;
    }

    return null;
  },
};
