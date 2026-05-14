import type { ProviderConfig } from '../../config';
import { readString, isPlainObject } from '../../lib/extract';

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
    if (!isPlainObject(payload)) return null;
    const eventRaw = (payload as SlackPayloadShape).event;
    if (!isPlainObject(eventRaw)) return null;
    const event = eventRaw as SlackEventShape;

    const channel = readString(event.channel);
    if (channel === undefined) return null;

    const channelType = readString(event.channel_type);
    const eventType = readString(event.type);
    const threadTs = readString(event.thread_ts);
    const ts = readString(event.ts);
    const hasAssistantThread =
      event.assistant_thread !== null && event.assistant_thread !== undefined;

    // DM: one conversation per DM channel, regardless of thread structure.
    if (channelType === 'im') return channel;

    // Assistant thread: starter has `assistant_thread`; continuations have
    // `channel_type=group` + `thread_ts`. Either way, key by channel only —
    // one conversation per assistant panel.
    if (hasAssistantThread) return channel;
    if (channelType === 'group' && threadTs !== undefined) return channel;

    // App mention in a regular channel: separate mentions are separate
    // conversations. Use `thread_ts ?? ts` so thread replies under the same
    // mention map to the same key as the mention itself.
    if (eventType === 'app_mention' && channelType === 'channel') {
      const conversationId = threadTs ?? ts;
      if (conversationId === undefined) return null;
      return `${channel}:${conversationId}`;
    }

    // Thread reply in a regular channel: continues the parent mention's session.
    if (eventType === 'message' && channelType === 'channel' && threadTs !== undefined) {
      return `${channel}:${threadTs}`;
    }

    return null;
  },
};
