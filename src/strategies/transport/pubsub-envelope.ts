/**
 * Google Cloud Pub/Sub push-envelope unwrap.
 *
 * Pub/Sub wraps every push notification as:
 *
 *   {
 *     "message": {
 *       "data": "<base64-encoded JSON or raw bytes>",
 *       "messageId": "...",
 *       "publishTime": "...",
 *       "attributes": { ... }       // optional
 *     },
 *     "subscription": "projects/.../subscriptions/..."
 *   }
 *
 * The actual notification (e.g. Gmail's `{emailAddress, historyId}`) is the
 * decoded `message.data`. Routing rules need to match on the inner payload,
 * not the wrapper, so this helper unwraps after signature validation and
 * returns the decoded inner JSON.
 *
 * If the input doesn't look like a Pub/Sub envelope, return it unchanged —
 * keeps the helper safe to call unconditionally when an operator
 * mis-configures the `envelope: pubsub` flag.
 */

import { isPlainObject } from '../../lib/extract';

export interface PubsubEnvelopeResult {
  /** The unwrapped inner payload — parsed JSON or the raw decoded string when not JSON. */
  readonly payload: unknown;
  /** True iff the wrapper looked like a Pub/Sub envelope and we successfully decoded it. */
  readonly unwrapped: boolean;
  /** When `unwrapped` is true, the original `subscription` field for audit/log context. */
  readonly subscription?: string;
  /** When `unwrapped` is true, the original `messageId` for dedup / trace correlation. */
  readonly messageId?: string;
}

/**
 * Detect + unwrap a Pub/Sub push envelope. Returns `{ unwrapped: false }`
 * when the input doesn't match the shape, so the caller can fall through
 * to whatever the next stage expects.
 */
export function decodePubsubEnvelope(rawPayload: unknown): PubsubEnvelopeResult {
  if (!isPlainObject(rawPayload)) return { payload: rawPayload, unwrapped: false };
  const message = rawPayload['message'];
  if (!isPlainObject(message)) return { payload: rawPayload, unwrapped: false };
  const data = message['data'];
  if (typeof data !== 'string') return { payload: rawPayload, unwrapped: false };

  let decoded: string;
  try {
    decoded = Buffer.from(data, 'base64').toString('utf-8');
  } catch {
    // Malformed base64 — leave the envelope intact for the route to reject.
    return { payload: rawPayload, unwrapped: false };
  }

  let inner: unknown;
  try {
    inner = JSON.parse(decoded);
  } catch {
    // Pub/Sub data can be arbitrary bytes; for non-JSON we still surface the
    // decoded string so the route can match on it if it wants.
    inner = decoded;
  }

  const subscription = rawPayload['subscription'];
  const messageId = message['messageId'];
  return {
    payload: inner,
    unwrapped: true,
    ...(typeof subscription === 'string' ? { subscription } : {}),
    ...(typeof messageId === 'string' ? { messageId } : {}),
  };
}
