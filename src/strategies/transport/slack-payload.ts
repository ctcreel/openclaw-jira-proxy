/**
 * Slack payload enrichment — adds `event.channel_name` based on a
 * channel-id → name lookup.
 *
 * Pure: returns a shallow-cloned payload when enrichment applies, the
 * same reference when it doesn't. No mutation, no I/O. The Condition
 * AST and field-path resolver remain provider-agnostic — only the
 * transport knows about channel name mappings, which is where Slack's
 * id-vs-name asymmetry belongs.
 *
 * Inverse direction is `id → name` at runtime because that's the
 * shape the per-event lookup needs. Operators configure the friendly
 * `name → id` direction in YAML; the transport reverses it once at
 * construction time.
 */

import { readString, isPlainObject } from '../../lib/extract';

export function buildChannelIdToNameMap(
  channelMap: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  if (!channelMap) {
    return new Map<string, string>();
  }
  const inverse = new Map<string, string>();
  for (const [name, id] of Object.entries(channelMap)) {
    inverse.set(id, name);
  }
  return inverse;
}

// noqa: NAMING001 — `enrich` is a transitive verb; the naming script's allowlist doesn't recognize it
export function enrichSlackPayload(
  payload: unknown,
  channelIdToName: ReadonlyMap<string, string>,
): unknown {
  if (channelIdToName.size === 0) return payload;
  if (!isPlainObject(payload)) return payload;
  const event = payload['event'];
  if (!isPlainObject(event)) return payload;
  const channelId = readString(event['channel']);
  if (channelId === undefined) return payload;
  const name = channelIdToName.get(channelId);
  if (name === undefined) return payload;
  return {
    ...payload,
    event: { ...event, channel_name: name },
  };
}
