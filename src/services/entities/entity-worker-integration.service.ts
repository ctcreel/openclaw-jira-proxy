import type { Actor } from '../../types/actor';

import type { AgentEntityContext, EntityRegistry } from './entity-registry';
import { extractMentions } from './entity-mention-extractor.service';
import type { InboundEvent } from './resolver-strategy';

export interface RunInteractionRecord {
  inbound_text: string;
  outbound_summary: string;
  surface: string;
  route: string;
  trace_id: string;
}

export interface RecordInteractionResult {
  interactionId: string | null;
  taggedMentions: string[];
  ambiguousMentions: string[];
}

export interface RecentInteractionsOptions {
  topN: number;
  includeMentionsOfRelatedEntities?: boolean;
}

const OUTBOUND_SUMMARY_TRUNCATION = 500;

export class EntityWorkerIntegration {
  constructor(private registry: EntityRegistry) {}

  resolveActor(agentName: string, event: InboundEvent): Actor | null {
    const context = this.registry.get(agentName);
    if (context === null) return null;
    return context.resolver.resolve(event);
  }

  recordInteraction(
    agentName: string,
    actor: Actor,
    record: RunInteractionRecord,
  ): RecordInteractionResult {
    const context = this.registry.get(agentName);
    if (context === null || !hasInteractionSchema(context)) {
      return { interactionId: null, taggedMentions: [], ambiguousMentions: [] };
    }

    const outboundSummary = truncate(record.outbound_summary, OUTBOUND_SUMMARY_TRUNCATION);
    const properties: Record<string, unknown> = {
      inbound_text: record.inbound_text,
      outbound_summary: outboundSummary,
      surface: record.surface,
      route: record.route,
      trace_id: record.trace_id,
    };
    if (actor.kind === 'stranger' && actor.email !== null) {
      properties['actor_email'] = actor.email;
    }

    const interaction = context.store.upsert(
      'interaction',
      `${record.surface}:${record.route}@${new Date().toISOString()}`,
      properties,
      { trace_id: record.trace_id, actor: 'framework:worker' },
    );

    if (actor.kind !== 'stranger' && actor.id !== null) {
      context.store.relate(interaction.id, 'from', actor.id, null, {
        trace_id: record.trace_id,
        actor: 'framework:worker',
      });
    }

    const combinedText = `${record.inbound_text}\n${outboundSummary}`;
    const mentions = extractMentions(combinedText, { store: context.store });
    const tagged: string[] = [];
    for (const match of mentions.matched) {
      if (actor.kind !== 'stranger' && match.entityId === actor.id) continue;
      context.store.relate(interaction.id, 'about', match.entityId, null, {
        trace_id: record.trace_id,
        actor: 'framework:worker',
      });
      tagged.push(match.entityId);
    }

    return {
      interactionId: interaction.id,
      taggedMentions: tagged,
      ambiguousMentions: mentions.ambiguous.map((entry) => entry.term),
    };
  }

  fetchRecentInteractions(
    agentName: string,
    actor: Actor,
    options: RecentInteractionsOptions,
  ): Array<{ id: string; properties: Record<string, unknown>; created_at: number }> {
    const context = this.registry.get(agentName);
    if (context === null) return [];
    if (!hasInteractionSchema(context)) return [];

    const interactions = new Map<
      string,
      { id: string; properties: Record<string, unknown>; created_at: number }
    >();

    if (actor.kind !== 'stranger' && actor.id !== null) {
      const byFrom = context.store.find({
        kinds: ['interaction'],
        related_to: actor.id,
        relation_type: 'from',
        order: { field: 'created_at', dir: 'desc' },
        limit: options.topN,
      });
      for (const entity of byFrom) {
        interactions.set(entity.id, {
          id: entity.id,
          properties: entity.properties,
          created_at: entity.created_at,
        });
      }

      if (options.includeMentionsOfRelatedEntities === true) {
        const relatedClientIds = this.getRelatedEntityIds(context, actor.id);
        for (const clientId of relatedClientIds) {
          const byAbout = context.store.find({
            kinds: ['interaction'],
            related_to: clientId,
            relation_type: 'about',
            order: { field: 'created_at', dir: 'desc' },
            limit: options.topN,
          });
          for (const entity of byAbout) {
            interactions.set(entity.id, {
              id: entity.id,
              properties: entity.properties,
              created_at: entity.created_at,
            });
          }
        }
      }
    }

    return Array.from(interactions.values())
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, options.topN);
  }

  private getRelatedEntityIds(context: AgentEntityContext, actorId: string): string[] {
    const expanded = context.store.get(actorId, { expand_relations: true });
    if (expanded === null) return [];
    const outgoing = expanded.outgoing ?? [];
    const ids = new Set<string>();
    for (const relation of outgoing) {
      if (relation.type === 'has_contact' || relation.type === 'is_contact_for') {
        ids.add(relation.to_id);
      }
    }
    const incoming = expanded.incoming ?? [];
    for (const relation of incoming) {
      if (relation.type === 'has_contact' && actorId.startsWith('p_')) {
        ids.add(relation.from_id);
      }
    }
    return Array.from(ids);
  }
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return value.slice(0, maximum) + '...';
}

function hasInteractionSchema(context: AgentEntityContext): boolean {
  return 'interaction' in context.workspace.schemas;
}
