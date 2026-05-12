/**
 * Slack Socket Mode envelope → routing-payload normalization.
 *
 * Slack's HTTP Events API and Socket Mode deliver the same `event` body
 * but wrapped differently:
 *
 *   HTTP:    { token, team_id, event: { type, user, channel, ts, ... }, ... }
 *   Socket:  { envelope_id, type: "events_api", payload: { token, team_id, event: { ... }, ... } }
 *
 * The downstream slack contextStrategy and routing rules already consume
 * the HTTP shape (they read `event.ts`, `event.channel`, `event.blocks`).
 * This mapper unwraps the Socket Mode envelope so everything past the
 * transport boundary stays unchanged.
 *
 * `url_verification` challenges arrive only over HTTP (Slack uses them
 * to confirm a webhook URL); Socket Mode authenticates at the socket
 * handshake instead. So this mapper does not handle that case.
 */
import { isPlainObject } from '../../lib/extract';

export function mapSocketModeEnvelopeToWebhookPayload(envelope: unknown): unknown {
  if (!isPlainObject(envelope)) return envelope;
  const payload = envelope['payload'];
  if (isPlainObject(payload)) return payload;
  // `events_api` envelopes always carry a payload; other envelope types
  // (slash_commands, interactive) are out of scope for this ticket.
  // Returning the raw envelope keeps the contract: routing will see the
  // shape that came in and most likely produce a no-routing-match.
  return envelope;
}
