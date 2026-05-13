import { githubPayloadSchema } from './github';
import { gmailPubsubPayloadSchema } from './gmail-pubsub';
import { internalPayloadSchema } from './internal';
import { jiraPayloadSchema } from './jira';
import { schedulePayloadSchema } from './schedule';
import { slackPayloadSchema } from './slack';
import type { JsonSchema } from './types';

/**
 * Provider-name → payload-shape registry. Lookup is by an exact name
 * first; falls back to a prefix match against the well-known provider
 * families so operator-named providers (e.g. `slack-winston`,
 * `gmail-heather`) inherit the canonical Slack / Gmail Pub/Sub shape.
 */

const EXACT_REGISTRY: ReadonlyMap<string, JsonSchema> = new Map([
  ['internal', internalPayloadSchema],
  ['schedule', schedulePayloadSchema],
  ['jira', jiraPayloadSchema],
  ['github', githubPayloadSchema],
  ['slack', slackPayloadSchema],
  ['gmail-pubsub', gmailPubsubPayloadSchema],
]);

const PREFIX_REGISTRY: readonly { prefix: string; schema: JsonSchema }[] = [
  { prefix: 'slack-', schema: slackPayloadSchema },
  { prefix: 'gmail-', schema: gmailPubsubPayloadSchema },
];

export function getProviderPayloadSchema(providerName: string): JsonSchema | undefined {
  const exact = EXACT_REGISTRY.get(providerName);
  if (exact !== undefined) return exact;
  for (const entry of PREFIX_REGISTRY) {
    if (providerName.startsWith(entry.prefix)) return entry.schema;
  }
  return undefined;
}

export function listKnownProviders(): readonly string[] {
  return [...EXACT_REGISTRY.keys()];
}

export type { JsonSchema } from './types';
export { resolveArrayItem, resolvePath } from './lookup';
