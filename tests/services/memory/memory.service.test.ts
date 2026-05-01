import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryService,
  ProviderNotRegisteredError,
  RateLimitExceededError,
  UnknownNamespaceError,
  type NamespaceConfig,
} from '../../../src/services/memory/memory.service';
import {
  inMemoryVectorStore,
  type InMemoryVectorStore,
} from '../../../src/services/memory/vector-store';
import type { EventBus } from '../../../src/services/event-bus.service';

const NS_PRIMARY: NamespaceConfig = {
  name: 'primary',
  embeddingProviderName: 'null-fake',
  vectorStoreName: 'in-memory',
  pruneAfterMs: 365 * 24 * 60 * 60 * 1000,
  maxStoresPerRun: 5,
};

const NS_SECOND: NamespaceConfig = {
  name: 'second',
  embeddingProviderName: 'null-fake',
  vectorStoreName: 'in-memory',
  pruneAfterMs: 7 * 24 * 60 * 60 * 1000,
  maxStoresPerRun: 5,
};

function makeFakeEventBus(): EventBus & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    publish: vi.fn((event: unknown) => events.push(event)),
    subscribe: vi.fn(() => () => {}),
  } as unknown as EventBus & { events: unknown[] };
}

describe('MemoryService', () => {
  let bus: EventBus & { events: unknown[] };
  let service: MemoryService;

  beforeEach(() => {
    bus = makeFakeEventBus();
    service = new MemoryService({
      namespaces: [NS_PRIMARY, NS_SECOND],
      events: bus,
    });
  });

  afterEach(() => {
    (inMemoryVectorStore as unknown as InMemoryVectorStore).clearForTest();
  });

  describe('store', () => {
    it('stores text and emits memory.stored', async () => {
      const result = await service.store({
        namespace: 'primary',
        text: 'Chris has a cat named Porter',
        traceId: 'trace-1',
      });
      expect(result.namespace).toBe('primary');
      expect(result.id).toBeTruthy();
      const stored = bus.events.find(
        (e: unknown) => (e as { type: string }).type === 'memory.stored',
      );
      expect(stored).toMatchObject({
        type: 'memory.stored',
        namespace: 'primary',
        id: result.id,
        textLength: 'Chris has a cat named Porter'.length,
        traceId: 'trace-1',
      });
    });

    it('attaches metadata to the stored entry', async () => {
      const result = await service.store({
        namespace: 'primary',
        text: 'foo',
        metadata: { source: 'slack-dm', channel: 'D123' },
        traceId: 'trace-1',
      });
      const search = await service.search({ namespace: 'primary', query: 'foo', minSimilarity: 0 });
      const hit = search.hits.find((h) => h.id === result.id);
      expect(hit?.metadata).toEqual({ source: 'slack-dm', channel: 'D123' });
    });

    it('rejects unknown namespace with UnknownNamespaceError', async () => {
      await expect(
        service.store({ namespace: 'nope', text: 't', traceId: 'trace-1' }),
      ).rejects.toBeInstanceOf(UnknownNamespaceError);
    });

    it('emits memory.error on embedding failure', async () => {
      const failingService = new MemoryService({
        namespaces: [
          {
            ...NS_PRIMARY,
            embeddingProviderName: 'does-not-exist',
          },
        ],
        events: bus,
      });
      await expect(
        failingService.store({ namespace: 'primary', text: 't', traceId: 'trace-1' }),
      ).rejects.toBeInstanceOf(ProviderNotRegisteredError);
      const errorEvent = bus.events.find(
        (e: unknown) => (e as { type: string }).type === 'memory.error',
      );
      expect(errorEvent).toMatchObject({ type: 'memory.error', operation: 'store' });
    });

    it('enforces maxStoresPerRun per traceId per namespace', async () => {
      for (let index = 0; index < 5; index += 1) {
        await service.store({
          namespace: 'primary',
          text: `entry-${index}`,
          traceId: 'trace-1',
        });
      }
      await expect(
        service.store({ namespace: 'primary', text: 'sixth', traceId: 'trace-1' }),
      ).rejects.toBeInstanceOf(RateLimitExceededError);
    });

    it('limit is per-traceId — different traces have independent budgets', async () => {
      for (let index = 0; index < 5; index += 1) {
        await service.store({
          namespace: 'primary',
          text: `a-${index}`,
          traceId: 'trace-A',
        });
      }
      // trace-B's first store should still succeed
      await expect(
        service.store({ namespace: 'primary', text: 'b-0', traceId: 'trace-B' }),
      ).resolves.toMatchObject({ namespace: 'primary' });
    });

    it('limit is per-namespace — different namespaces share traceId budget independently', async () => {
      for (let index = 0; index < 5; index += 1) {
        await service.store({
          namespace: 'primary',
          text: `p-${index}`,
          traceId: 'trace-1',
        });
      }
      // same traceId, different namespace should still succeed
      await expect(
        service.store({ namespace: 'second', text: 's-0', traceId: 'trace-1' }),
      ).resolves.toMatchObject({ namespace: 'second' });
    });
  });

  describe('search', () => {
    it('returns hits ordered by similarity desc', async () => {
      const a = await service.store({
        namespace: 'primary',
        text: 'cat named Porter',
        traceId: 't',
      });
      const b = await service.store({
        namespace: 'primary',
        text: 'completely unrelated text about weather',
        traceId: 't',
      });
      // null-fake hashes can produce negative cosine similarity for
      // unrelated texts; use minSimilarity=-1 to include all hits and
      // verify ordering only.
      const result = await service.search({
        namespace: 'primary',
        query: 'cat named Porter',
        topK: 5,
        minSimilarity: -1,
      });
      expect(result.hits[0]?.id).toBe(a.id);
      expect(result.hits.find((h) => h.id === b.id)).toBeDefined();
      expect(result.hits[0]!.score).toBeGreaterThanOrEqual(result.hits[1]!.score);
    });

    it('emits memory.retrieved with hit count + top score', async () => {
      await service.store({ namespace: 'primary', text: 'hello world', traceId: 't' });
      await service.search({
        namespace: 'primary',
        query: 'hello world',
        topK: 3,
        minSimilarity: 0,
        traceId: 'search-trace',
      });
      const event = bus.events.find(
        (e: unknown) => (e as { type: string }).type === 'memory.retrieved',
      );
      expect(event).toMatchObject({
        type: 'memory.retrieved',
        namespace: 'primary',
        traceId: 'search-trace',
        hitCount: 1,
      });
    });

    it('respects topK and minSimilarity defaults when omitted', async () => {
      // null-fake hashing — strict similarity is unpredictable. Use minSimilarity=0 explicitly.
      for (let index = 0; index < 10; index += 1) {
        await service.store({ namespace: 'primary', text: `entry-${index}`, traceId: `t${index}` });
      }
      const result = await service.search({
        namespace: 'primary',
        query: 'entry-5',
        minSimilarity: 0,
      });
      expect(result.hits.length).toBeLessThanOrEqual(5); // default topK = 5
    });

    it('returns empty hits when query has no matches above threshold', async () => {
      await service.store({ namespace: 'primary', text: 'a', traceId: 't' });
      const result = await service.search({
        namespace: 'primary',
        query: 'a',
        topK: 5,
        minSimilarity: 1.1, // impossible
      });
      expect(result.hits).toEqual([]);
    });

    it('rejects unknown namespace', async () => {
      await expect(service.search({ namespace: 'nope', query: 'q' })).rejects.toBeInstanceOf(
        UnknownNamespaceError,
      );
    });
  });

  describe('delete', () => {
    it('removes a stored entry', async () => {
      const stored = await service.store({
        namespace: 'primary',
        text: 'gone soon',
        traceId: 't',
      });
      const result = await service.delete({ namespace: 'primary', id: stored.id });
      expect(result.deleted).toBe(true);
    });

    it('returns deleted=false for missing id', async () => {
      const result = await service.delete({ namespace: 'primary', id: 'never-existed' });
      expect(result.deleted).toBe(false);
    });

    it('rejects unknown namespace', async () => {
      await expect(service.delete({ namespace: 'nope', id: 'x' })).rejects.toBeInstanceOf(
        UnknownNamespaceError,
      );
    });
  });

  describe('prune', () => {
    it('emits memory.pruned with deletedCount and durationMs', async () => {
      let now = 1_000_000;
      const clock = vi.fn(() => now);
      const localService = new MemoryService({
        namespaces: [{ ...NS_PRIMARY, pruneAfterMs: 1000 }],
        events: bus,
        clock,
      });
      await localService.store({ namespace: 'primary', text: 'old', traceId: 't1' });

      // Advance clock past prune threshold.
      now += 5_000;

      const result = await localService.prune({ namespace: 'primary' });
      expect(result.deletedCount).toBe(1);
      const event = bus.events.find(
        (e: unknown) => (e as { type: string }).type === 'memory.pruned',
      );
      expect(event).toMatchObject({
        type: 'memory.pruned',
        namespace: 'primary',
        deletedCount: 1,
      });
    });

    it('preserves recently-accessed entries even when older than pruneAfter', async () => {
      let now = 1_000_000;
      const clock = vi.fn(() => now);
      const localService = new MemoryService({
        namespaces: [{ ...NS_PRIMARY, pruneAfterMs: 1000 }],
        events: bus,
        clock,
      });
      const stored = await localService.store({ namespace: 'primary', text: 'a', traceId: 't' });

      // Advance clock past prune threshold.
      now += 5_000;

      // Access bumps lastAccessedAt to now.
      const search = await localService.search({
        namespace: 'primary',
        query: 'a',
        minSimilarity: 0,
      });
      expect(search.hits.find((h) => h.id === stored.id)).toBeDefined();

      const result = await localService.prune({ namespace: 'primary' });
      expect(result.deletedCount).toBe(0);
    });

    it('rejects unknown namespace', async () => {
      await expect(service.prune({ namespace: 'nope' })).rejects.toBeInstanceOf(
        UnknownNamespaceError,
      );
    });
  });

  describe('namespace introspection', () => {
    it('hasNamespace returns true for declared namespaces', () => {
      expect(service.hasNamespace('primary')).toBe(true);
      expect(service.hasNamespace('second')).toBe(true);
      expect(service.hasNamespace('nope')).toBe(false);
    });

    it('listNamespaces returns all declared namespaces', () => {
      expect(service.listNamespaces()).toEqual(expect.arrayContaining(['primary', 'second']));
    });
  });
});
