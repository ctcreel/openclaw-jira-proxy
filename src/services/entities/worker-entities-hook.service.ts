import type { Actor } from '../../types/actor';

import { getEntityRegistry, type EntityRegistry } from './entity-registry';
import { renderEntityModel } from './entity-model-renderer.service';
import { EntityWorkerIntegration } from './entity-worker-integration.service';
import { extractIdentityHints, type SurfaceKind } from './identity-hint-extractor.service';

export interface RulePolicy {
  entities?: { kinds: string[] };
  interactions?: { topN: number; includeMentionsOfRelatedEntities: boolean };
}

export interface RunDescriptor {
  agentName: string;
  providerName: string;
  ruleName: string;
  traceId: string;
}

export interface PreparedEntityContext {
  actor: Actor | null;
  entity_model: string | undefined;
  interactions: unknown[];
}

const PROVIDER_TO_SURFACE: Record<string, SurfaceKind> = {
  'slack-winston': 'slack',
  'slack-socket': 'slack',
  slack: 'slack',
  'gmail-pubsub': 'gmail',
  gmail: 'gmail',
};

function resolveSurface(providerName: string): SurfaceKind {
  const known = PROVIDER_TO_SURFACE[providerName];
  if (known !== undefined) return known;
  if (providerName.includes('slack')) return 'slack';
  if (providerName.includes('gmail')) return 'gmail';
  if (providerName.includes('email')) return 'gmail';
  return 'http';
}

export class WorkerEntitiesHook {
  private integration: EntityWorkerIntegration;

  constructor(private registry: EntityRegistry = getEntityRegistry()) {
    this.integration = new EntityWorkerIntegration(this.registry);
  }

  /**
   * Pre-render hook. Called after memories are fetched but before the
   * template renders. Resolves the actor, fetches recent interactions
   * if the rule opts in, and synthesizes the entity_model markdown.
   *
   * Returns an empty context (all undefined/null/empty) when the
   * agent has no entity registration, or when the rule doesn't
   * declare entities.kinds. Callers should use {@link hasEntityScope}
   * to decide whether to pass the context to the template renderer.
   */
  prepare(rule: RulePolicy, descriptor: RunDescriptor, payload: unknown): PreparedEntityContext {
    const context = this.registry.get(descriptor.agentName);
    if (context === null || rule.entities === undefined) {
      return { actor: null, entity_model: undefined, interactions: [] };
    }
    const surface = resolveSurface(descriptor.providerName);
    const hints = extractIdentityHints(surface, payload);
    const actor = this.integration.resolveActor(descriptor.agentName, { identityHints: hints });
    const entityModel = renderEntityModel({
      schemas: context.workspace.schemas,
      relations: context.workspace.relations,
      kinds: rule.entities.kinds,
    });
    let interactions: unknown[] = [];
    if (rule.interactions !== undefined && actor !== null) {
      const recent = this.integration.fetchRecentInteractions(descriptor.agentName, actor, {
        topN: rule.interactions.topN,
        includeMentionsOfRelatedEntities: rule.interactions.includeMentionsOfRelatedEntities,
      });
      interactions = recent.map((entry) => ({
        id: entry.id,
        ...entry.properties,
        created_at: entry.created_at,
      }));
    }
    return { actor, entity_model: entityModel, interactions };
  }

  /**
   * Post-run hook. Writes one interaction entity for the just-completed
   * turn, sets the --from--> relation, and runs the deterministic mention
   * extractor to tag --about--> relations. Best-effort: failure logged
   * but never throws.
   */
  recordTurn(
    rule: RulePolicy,
    descriptor: RunDescriptor,
    actor: Actor | null,
    inboundText: string,
    outboundSummary: string,
  ): void {
    if (actor === null || rule.entities === undefined) return;
    const surface = resolveSurface(descriptor.providerName);
    try {
      this.integration.recordInteraction(descriptor.agentName, actor, {
        inbound_text: inboundText,
        outbound_summary: outboundSummary,
        surface,
        route: `${descriptor.providerName}.${descriptor.ruleName}`,
        trace_id: descriptor.traceId,
      });
    } catch {
      // best-effort; the worker continues regardless
    }
  }
}

let singleton: WorkerEntitiesHook | null = null;

export function getWorkerEntitiesHook(): WorkerEntitiesHook {
  if (singleton === null) {
    singleton = new WorkerEntitiesHook();
  }
  return singleton;
}

export function resetWorkerEntitiesHook(): void {
  singleton = null;
}
