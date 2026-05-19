import type { Request, Response } from 'express';

import { getStringParameter } from '../lib/extract';
import { getLogger } from '../lib/logging';
import type { ResolvedAgent } from '../services/agent-loader.service';
import { getEntityRegistry, type EntityRegistry } from '../services/entities/entity-registry';

const logger = getLogger('workspace-entity-model-controller');

/**
 * Returns the loaded entity-model metadata for a given agent in a
 * single payload. Designed for the future drag-and-drop UI to read
 * everything it needs without N+1 round-trips:
 *
 *   - The loaded kind schemas (with descriptions, required fields,
 *     formats, enums) — drives form rendering
 *   - relations.json — drives the relation-graph visualization
 *   - Rules that declare `entities.kinds` — shows which routes can
 *     touch which kinds
 *
 * The endpoint is read-only. Edits go through the existing
 * `/api/workspace/:agent/edit` PR-style write-back flow.
 */
export interface KindMetadata {
  kind: string;
  schema: unknown;
}

export interface RuleEntityReference {
  ruleId: string | undefined;
  ruleName: string | undefined;
  entities: { kinds: string[] };
}

export interface WorkspaceEntityModelPayload {
  agent: string;
  kinds: KindMetadata[];
  relations: Record<string, unknown>;
  rules: RuleEntityReference[];
}

export function createWorkspaceEntityModelHandler(
  agents: readonly ResolvedAgent[],
  registry: EntityRegistry = getEntityRegistry(),
) {
  return (request: Request, response: Response): void => {
    const agentName = getStringParameter(request, 'agent');
    if (agentName === undefined) {
      response.status(400).json({ error: 'Missing :agent path parameter' });
      return;
    }
    const context = registry.get(agentName);
    if (context === null) {
      response.status(404).json({ error: `Agent '${agentName}' has no entity store` });
      return;
    }

    const kinds: KindMetadata[] = Object.entries(context.workspace.schemas).map(
      ([kind, schema]) => ({ kind, schema }),
    );

    const matchedAgent = agents.find((agent) => agent.name === agentName);
    const rulesWithEntities: RuleEntityReference[] = [];
    if (matchedAgent !== undefined) {
      for (const [providerName, providerRoutes] of Object.entries(
        matchedAgent.config.routing ?? {},
      )) {
        const rules = (providerRoutes as { rules?: ReadonlyArray<unknown> }).rules ?? [];
        for (const rawRule of rules) {
          const rule = rawRule as {
            id?: string;
            name?: string;
            entities?: { kinds: string[] };
          };
          if (rule.entities === undefined) continue;
          rulesWithEntities.push({
            ruleId: rule.id,
            ruleName: rule.name ?? `${providerName}.${rule.id ?? '<unnamed>'}`,
            entities: rule.entities,
          });
        }
      }
    }

    const payload: WorkspaceEntityModelPayload = {
      agent: agentName,
      kinds,
      relations: context.workspace.relations as unknown as Record<string, unknown>,
      rules: rulesWithEntities,
    };

    logger.info(
      { agent: agentName, kindCount: kinds.length, ruleCount: rulesWithEntities.length },
      'workspace entity-model served',
    );
    response.status(200).json(payload);
  };
}
