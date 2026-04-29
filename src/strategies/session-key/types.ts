import { z } from 'zod';

import type { ProviderConfig } from '../../config';
import { parseDurationToMs } from '../../lib/duration';

/**
 * Provider-specific function that derives the session-pool key for an event.
 *
 * Returns the key when the event belongs to a recognizable conversation
 * (e.g. a Slack DM channel ID, or `${channel}:${thread_ts}` for a channel
 * mention thread). Returns `null` when the event shape isn't one this
 * strategy handles — the worker MUST then fall back to the per-event-spawn
 * path for that single event.
 *
 * Strategies are pure: no I/O, no Redis lookups, no logging. They derive the
 * key from the parsed payload and provider config alone.
 */
export interface SessionKeyStrategy {
  readonly name: string;
  extract(payload: unknown, providerConfig: ProviderConfig): string | null;
}

/**
 * Per-rule session config attached to a routing rule. Authored as YAML:
 *
 * ```yaml
 * session:
 *   strategy: slack
 *   ttl: 7d
 *   idleTimeout: 30m
 * ```
 *
 * The schema parses durations to milliseconds; downstream code never deals
 * with the human-readable form.
 */
export const sessionConfigSchema = z
  .object({
    strategy: z.string().min(1),
    ttl: z
      .string()
      .min(1)
      .transform((value, ctx) => {
        try {
          return parseDurationToMs(value);
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
          });
          return z.NEVER;
        }
      }),
    idleTimeout: z
      .string()
      .min(1)
      .transform((value, ctx) => {
        try {
          return parseDurationToMs(value);
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
          });
          return z.NEVER;
        }
      }),
  })
  .strict();

export type SessionConfig = z.infer<typeof sessionConfigSchema>;
