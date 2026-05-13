import type { JsonSchema } from './types';

/**
 * Slack Events API payload shape. Both webhook delivery (HTTP) and
 * Socket Mode delivery produce the same `{event, ...envelope}` shape
 * after the transport unwraps protocol-level wrapping, so this schema
 * applies to either.
 *
 * The actual `event` body varies by `event.type` (message,
 * app_mention, reaction_added, ...). Routing rules condition on
 * `event.type` to discriminate; the audit doesn't enforce a tagged-
 * union strictness today.
 */
export const slackPayloadSchema: JsonSchema = {
  type: 'object',
  properties: {
    team_id: { type: 'string' },
    api_app_id: { type: 'string' },
    type: { type: 'string', description: 'Top-level event type (e.g. `event_callback`).' },
    event_id: { type: 'string' },
    event_time: { type: 'integer' },
    authorizations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          enterprise_id: { type: ['string', 'null'] as const },
          team_id: { type: 'string' },
          user_id: { type: 'string' },
          is_bot: { type: 'boolean' },
        },
        additionalProperties: true,
      },
    },
    event: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            'Inner event type (`message`, `app_mention`, `reaction_added`, `message.channels`, ...).',
        },
        user: { type: 'string', description: 'Slack user id of the actor.' },
        bot_id: { type: 'string', description: 'Set when the event originated from a bot.' },
        bot_profile: {
          type: 'object',
          properties: { name: { type: 'string' }, app_id: { type: 'string' } },
          additionalProperties: true,
        },
        channel: { type: 'string', description: 'Channel id (C... for channels, D... for DMs).' },
        channel_type: { type: 'string', description: 'channel / im / mpim / group.' },
        ts: { type: 'string', description: 'Message timestamp (epoch.us).' },
        thread_ts: {
          type: 'string',
          description: 'Parent thread ts; absent for top-level messages.',
        },
        text: { type: 'string' },
        subtype: { type: 'string', description: 'message_changed, channel_join, etc.' },
        blocks: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        attachments: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        assistant_thread: {
          type: 'object',
          description: 'Set for Slack Assistant sidebar threads.',
          additionalProperties: true,
        },
        reaction: { type: 'string' },
        item: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            channel: { type: 'string' },
            ts: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};
