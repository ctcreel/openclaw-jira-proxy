import type { Request, Response } from 'express';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { agentConfigSchema, agentRuleSchema } from '../services/agent-loader.service';
import { conditionSchema } from '../strategies/routing';

/**
 * GET /api/schema/routing
 *
 * Surfaces the clawndom.yaml routing vocabulary as JSON Schema documents
 * so the editor UI can autocomplete predicate types (`equals`, `in`,
 * `matches`, `exists`, `all_of`, `any_of`, `not`), drive field-level
 * validation client-side, and stop hardcoding the matcher knowledge
 * that lives in `src/strategies/routing/condition.ts`.
 *
 * Three slices, each a JSON Schema rooted at the corresponding Zod
 * schema:
 *
 *   - `condition` — predicate vocabulary alone. Drives the
 *     condition-builder UI.
 *   - `agentRule` — the full rule shape (condition + template + tools +
 *     dispatches + inputs + memory + session + identity overrides).
 *     Drives the rule inspector form.
 *   - `agentConfig` — top-level `clawndom.yaml` shape (routing +
 *     modelRules + memory namespaces). Drives the workspace tree view
 *     and validates the document before a PR-style write is composed.
 *
 * Schemas are computed lazily at first request and cached for the
 * process lifetime — the underlying Zod definitions don't change after
 * boot.
 */

let cachedSchemas: ReturnType<typeof buildSchemas> | null = null;

function buildSchemas(): {
  condition: ReturnType<typeof zodToJsonSchema>;
  agentRule: ReturnType<typeof zodToJsonSchema>;
  agentConfig: ReturnType<typeof zodToJsonSchema>;
} {
  return {
    condition: zodToJsonSchema(conditionSchema, { name: 'Condition' }),
    agentRule: zodToJsonSchema(agentRuleSchema, { name: 'AgentRule' }),
    agentConfig: zodToJsonSchema(agentConfigSchema, { name: 'AgentConfig' }),
  };
}

export function getRoutingSchemas(): {
  condition: ReturnType<typeof zodToJsonSchema>;
  agentRule: ReturnType<typeof zodToJsonSchema>;
  agentConfig: ReturnType<typeof zodToJsonSchema>;
} {
  if (cachedSchemas === null) {
    cachedSchemas = buildSchemas();
  }
  return cachedSchemas;
}

export function handleRoutingSchema(_request: Request, response: Response): void {
  response.json(getRoutingSchemas());
}

/**
 * Reset the cache. Test-only — schemas are derived from compiled-in
 * Zod definitions, so production code never needs to invalidate.
 */
export function resetRoutingSchemaCache(): void {
  cachedSchemas = null;
}
