import { z } from 'zod';

import type { Actor } from '../../types/actor';

import type { EntityStore } from './entity-store.service';
import type { IdentityPropertyIndex } from './entity-schema.service';
import { EmailResolverStrategy } from './strategies/email.resolver';
import { SlackUserIdResolverStrategy } from './strategies/slack-user-id.resolver';
import {
  getTargetsFor,
  type InboundEvent,
  type ResolverStrategy,
  type ResolverStrategyIndex,
} from './resolver-strategy';

export interface EntityResolverOptions {
  store: EntityStore;
  identityProperties: IdentityPropertyIndex;
  strategies?: ResolverStrategy[];
}

export class EntityResolver {
  private store: EntityStore;
  private strategies: ResolverStrategy[];
  private index: ResolverStrategyIndex;

  constructor(options: EntityResolverOptions) {
    this.store = options.store;
    this.strategies = (
      options.strategies ?? [new SlackUserIdResolverStrategy(), new EmailResolverStrategy()]
    )
      .slice()
      .sort((a, b) => a.priority - b.priority);
    this.index = {
      byFormat: options.identityProperties.byFormat,
      byPropertyName: options.identityProperties.byPropertyName,
    };
  }

  resolve(event: InboundEvent): Actor {
    for (const strategy of this.strategies) {
      const rawHint = strategy.extractHint(event);
      if (rawHint === null || rawHint === '') continue;
      const normalized = strategy.normalize(rawHint);
      const targets = getTargetsFor(strategy, this.index);
      for (const target of targets) {
        const match = this.findByProperty(target.kind, target.property, normalized);
        if (match !== null) {
          return this.entityToActor(match);
        }
      }
    }
    const fallbackEmail = event.identityHints?.email ?? event.identityHints?.oidc_email ?? null;
    return { kind: 'stranger', id: null, email: fallbackEmail };
  }

  private findByProperty(
    kind: string,
    propertyName: string,
    value: string,
  ): { id: string; kind: string; name: string; properties: Record<string, unknown> } | null {
    const row = this.store.database
      .prepare<
        [string, string, string],
        { id: string; kind: string; name: string; properties: string }
      >(
        `SELECT id, kind, name, properties FROM entities
         WHERE kind = ? AND LOWER(json_extract(properties, '$.' || ?)) = LOWER(?)
         LIMIT 1`,
      )
      .get(kind, propertyName, value);
    if (row === undefined) return null;
    const properties = z.record(z.string(), z.unknown()).parse(JSON.parse(row.properties));
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      properties,
    };
  }

  private entityToActor(entity: {
    id: string;
    kind: string;
    name: string;
    properties: Record<string, unknown>;
  }): Actor {
    return {
      kind: entity.kind,
      id: entity.id,
      name: entity.name,
      ...entity.properties,
    };
  }
}
