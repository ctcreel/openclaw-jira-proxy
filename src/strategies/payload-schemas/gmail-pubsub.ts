import type { JsonSchema } from './types';

/**
 * Gmail Pub/Sub push payload. The watch notification carries only the
 * mailbox identifier + a history cursor; agents fetch the actual
 * message(s) via the History API using `historyId` as the cursor.
 *
 * Routing rules typically condition only on `emailAddress` to route
 * per-mailbox (Winston's triage-heather-inbox vs relay-winston-inbox
 * vs scan-therapist-inbox patterns).
 */
export const gmailPubsubPayloadSchema: JsonSchema = {
  type: 'object',
  properties: {
    emailAddress: {
      type: 'string',
      description: 'The mailbox that produced the history event.',
    },
    historyId: {
      type: 'string',
      description: 'Cursor for the Gmail History API to enumerate new messages since.',
    },
  },
  required: ['emailAddress', 'historyId'],
  additionalProperties: false,
};
