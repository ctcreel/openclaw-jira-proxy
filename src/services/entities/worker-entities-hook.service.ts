import type { Actor } from '../../types/actor';

import { getEntityRegistry, type EntityRegistry } from './entity-registry';
import { renderEntityModel } from './entity-model-renderer.service';
import { EntityWorkerIntegration } from './entity-worker-integration.service';
import { extractIdentityHints, type SurfaceKind } from './identity-hint-extractor.service';

export interface RulePolicy {
  entities?: { kinds: string[] };
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
   * Pre-render hook. Called before the template renders. Resolves the
   * actor and synthesizes the entity_model markdown handbook scoped
   * to the rule's entities.kinds.
   *
   * Interaction retrieval is deliberately NOT done here — agents call
   * the `history` and `recall` tools to fetch the parameters that
   * match the event (since=24h, about_entity=X, etc.) instead of
   * receiving a static topN auto-injection.
   *
   * Returns null actor + undefined entity_model when the agent has
   * no entity registration or the rule doesn't declare entities.kinds.
   */
  prepare(rule: RulePolicy, descriptor: RunDescriptor, payload: unknown): PreparedEntityContext {
    const context = this.registry.get(descriptor.agentName);
    if (context === null || rule.entities === undefined) {
      return { actor: null, entity_model: undefined };
    }
    const surface = resolveSurface(descriptor.providerName);
    const hints = extractIdentityHints(surface, payload);
    const actor = this.integration.resolveActor(descriptor.agentName, { identityHints: hints });
    const entityModel = renderEntityModel({
      schemas: context.workspace.schemas,
      relations: context.workspace.relations,
      kinds: rule.entities.kinds,
    });
    return { actor, entity_model: entityModel };
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
    this.integration.recordInteraction(descriptor.agentName, actor, {
      inbound_text: inboundText,
      outbound_summary: outboundSummary,
      surface,
      route: `${descriptor.providerName}.${descriptor.ruleName}`,
      trace_id: descriptor.traceId,
    });
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
