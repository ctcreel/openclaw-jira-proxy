import { getProviderPayloadSchema, type JsonSchema } from '../strategies/payload-schemas';

import type { ResolvedAgent } from './agent-loader.service';

/**
 * For each provider the agent has rules under, return the JSON Schema
 * describing the inbound payload shape. Editor condition-builder UIs
 * use this to drive typeahead — drilling `event.channel` should show
 * "channel: string" as a documented field rather than letting the
 * user type a path that resolves to undefined at runtime.
 *
 * Providers without a registered schema (custom transport types, future
 * additions before their schema lands) are simply omitted from the
 * result — the UI gracefully degrades to free-text path entry for
 * those.
 */
export interface ContextSchemas {
  readonly agent: string;
  readonly providers: Readonly<Record<string, JsonSchema>>;
}

export function buildContextSchemas(agent: ResolvedAgent): ContextSchemas {
  const providers: Record<string, JsonSchema> = {};
  for (const providerName of Object.keys(agent.config.routing)) {
    const schema = getProviderPayloadSchema(providerName);
    if (schema !== undefined) providers[providerName] = schema;
  }
  return { agent: agent.name, providers };
}
