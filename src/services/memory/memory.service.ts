import { randomUUID } from 'node:crypto';

import { getLogger } from '../../lib/logging';
import type { EventBus } from '../event-bus.service';
import { getEventBus } from '../event-bus.service';

import { getEmbeddingProvider } from './embedding';
import type { EmbeddingProvider } from './embedding';
import type {
  DeleteInput,
  NamespaceConfig,
  PruneInput,
  PruneOutput,
  SearchInput,
  SearchOutput,
  StoreInput,
  StoreOutput,
} from './types';
import { ProviderNotRegisteredError, RateLimitExceededError, UnknownNamespaceError } from './types';
import { getVectorStore } from './vector-store';
import type { MemoryEntry, VectorStore } from './vector-store';

/**
 * Orchestrator for the memory subsystem. Composes a registered
 * EmbeddingProvider with a registered VectorStore on a per-namespace
 * basis, exposes store/search/delete/prune to HTTP controllers and
 * the worker pre-render hook, enforces per-run store rate limits,
 * emits SSE lifecycle events.
 *
 * The service does not own credentials. EmbeddingProviders that need
 * keys (e.g. OpenAI) are constructed at bootstrap time with the keys
 * resolved from SecretManager and registered into the embedding-provider
 * registry. By the time the service looks them up, they're ready.
 *
 * Per-run rate limiting: the in-memory `runCounters` map tracks store
 * calls per `(traceId, namespace)` pair. Entries are evicted after a
 * grace window past the last touch (default 10 minutes — long enough
 * to outlast the longest expected agent run). This bounds memory
 * without making the limit a hard global counter.
 */
const COUNTER_TTL_MS = 600_000;

const logger = getLogger('memory-service');

export interface MemoryServiceOptions {
  readonly namespaces: readonly NamespaceConfig[];
  readonly events?: EventBus;
  /** Injectable for tests. Defaults to `() => Date.now()`. */
  readonly clock?: () => number;
}

interface RunCounter {
  readonly counts: Map<string, number>;
  lastTouchedAt: number;
}

export class MemoryService {
  private readonly namespacesByName: Map<string, NamespaceConfig>;
  private readonly events: EventBus;
  private readonly clock: () => number;
  private readonly runCounters: Map<string, RunCounter> = new Map();

  constructor(options: MemoryServiceOptions) {
    this.namespacesByName = new Map(options.namespaces.map((ns) => [ns.name, ns]));
    this.events = options.events ?? getEventBus();
    this.clock = options.clock ?? ((): number => Date.now());
  }

  hasNamespace(name: string): boolean {
    return this.namespacesByName.has(name);
  }

  listNamespaces(): readonly string[] {
    return Array.from(this.namespacesByName.keys());
  }

  async store(input: StoreInput): Promise<StoreOutput> {
    const { namespace, traceId, text, metadata } = input;
    const config = this.requireNamespace(namespace);
    this.consumeRateBudget(traceId, namespace, config.maxStoresPerRun);

    try {
      const embedding = this.requireEmbeddingProvider(config);
      const store = this.requireVectorStore(config);
      const vector = await embedding.embed(text);
      const now = this.clock();
      const entry: MemoryEntry = {
        id: randomUUID(),
        namespace,
        text,
        metadata: metadata ?? {},
        vector,
        createdAt: now,
        lastAccessedAt: now,
      };
      await store.upsert(entry);
      this.events.publish({
        type: 'memory.stored',
        timestamp: now,
        traceId,
        namespace,
        id: entry.id,
        textLength: text.length,
      });
      logger.info({ namespace, id: entry.id, textLength: text.length, traceId }, 'Memory stored');
      return { id: entry.id, namespace };
    } catch (error) {
      this.publishError('store', namespace, traceId, error);
      throw error;
    }
  }

  async search(input: SearchInput): Promise<SearchOutput> {
    const { namespace, query } = input;
    const traceId = input.traceId ?? 'no-trace';
    const config = this.requireNamespace(namespace);

    const topK = input.topK ?? 5;
    const minSimilarity = input.minSimilarity ?? 0.7;

    try {
      const embedding = this.requireEmbeddingProvider(config);
      const store = this.requireVectorStore(config);
      const queryVector = await embedding.embed(query);
      const hits = await store.search({ namespace, queryVector, topK, minSimilarity });
      const topScore = hits[0]?.score;
      this.events.publish({
        type: 'memory.retrieved',
        timestamp: this.clock(),
        traceId,
        namespace,
        queryLength: query.length,
        hitCount: hits.length,
        ...(topScore !== undefined ? { topScore } : {}),
      });
      logger.info(
        { namespace, queryLength: query.length, hitCount: hits.length, traceId },
        'Memory retrieved',
      );
      return {
        hits: hits.map((hit) => ({
          id: hit.id,
          text: hit.text,
          metadata: hit.metadata,
          score: hit.score,
        })),
      };
    } catch (error) {
      this.publishError('search', namespace, traceId, error);
      throw error;
    }
  }

  async delete(input: DeleteInput): Promise<{ deleted: boolean }> {
    const { namespace, id } = input;
    const config = this.requireNamespace(namespace);
    try {
      const store = this.requireVectorStore(config);
      const deleted = await store.delete(id, namespace);
      logger.info({ namespace, id, deleted }, 'Memory delete');
      return { deleted };
    } catch (error) {
      this.publishError('delete', namespace, 'admin', error);
      throw error;
    }
  }

  async prune(input: PruneInput): Promise<PruneOutput> {
    const { namespace } = input;
    const config = this.requireNamespace(namespace);
    const now = this.clock();
    const olderThanMs = now - config.pruneAfterMs;
    const startedAt = now;
    try {
      const store = this.requireVectorStore(config);
      const deletedCount = await store.prune({ namespace, olderThanMs });
      const durationMs = this.clock() - startedAt;
      this.events.publish({
        type: 'memory.pruned',
        timestamp: this.clock(),
        traceId: 'pruning',
        namespace,
        deletedCount,
        durationMs,
      });
      logger.info({ namespace, deletedCount, durationMs }, 'Memory pruned');
      return { namespace, deletedCount, durationMs };
    } catch (error) {
      this.publishError('prune', namespace, 'pruning', error);
      throw error;
    }
  }

  private requireNamespace(name: string): NamespaceConfig {
    const config = this.namespacesByName.get(name);
    if (config === undefined) {
      throw new UnknownNamespaceError(name);
    }
    return config;
  }

  private requireEmbeddingProvider(config: NamespaceConfig): EmbeddingProvider {
    const provider = getEmbeddingProvider(config.embeddingProviderName);
    if (provider === undefined) {
      throw new ProviderNotRegisteredError('embedding', config.embeddingProviderName);
    }
    return provider;
  }

  private requireVectorStore(config: NamespaceConfig): VectorStore {
    const store = getVectorStore(config.vectorStoreName);
    if (store === undefined) {
      throw new ProviderNotRegisteredError('vector-store', config.vectorStoreName);
    }
    return store;
  }

  private consumeRateBudget(traceId: string, namespace: string, limit: number): void {
    this.evictStaleCounters();
    let counter = this.runCounters.get(traceId);
    if (counter === undefined) {
      counter = { counts: new Map(), lastTouchedAt: this.clock() };
      this.runCounters.set(traceId, counter);
    }
    const current = counter.counts.get(namespace) ?? 0;
    if (current >= limit) {
      throw new RateLimitExceededError(namespace, traceId, limit);
    }
    counter.counts.set(namespace, current + 1);
    counter.lastTouchedAt = this.clock();
  }

  private evictStaleCounters(): void {
    const cutoff = this.clock() - COUNTER_TTL_MS;
    for (const [traceId, counter] of this.runCounters.entries()) {
      if (counter.lastTouchedAt < cutoff) {
        this.runCounters.delete(traceId);
      }
    }
  }

  private publishError(
    operation: 'store' | 'search' | 'delete' | 'prune',
    namespace: string,
    traceId: string,
    error: unknown,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.events.publish({
      type: 'memory.error',
      timestamp: this.clock(),
      traceId,
      namespace,
      operation,
      errorMessage,
    });
    logger.error({ operation, namespace, traceId, errorMessage }, 'Memory operation failed');
  }
}

let singleton: MemoryService | null = null;

export function getMemoryService(): MemoryService {
  if (singleton === null) {
    throw new Error(
      'MemoryService not initialized. Call initializeMemoryService() at server startup.',
    );
  }
  return singleton;
}

export function initializeMemoryService(options: MemoryServiceOptions): MemoryService {
  singleton = new MemoryService(options);
  return singleton;
}

export function setMemoryServiceForTest(service: MemoryService | null): void {
  singleton = service;
}

export type { NamespaceConfig } from './types';
export { ProviderNotRegisteredError, RateLimitExceededError, UnknownNamespaceError } from './types';
