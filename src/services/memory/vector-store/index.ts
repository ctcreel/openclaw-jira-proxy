import { inMemoryVectorStore } from './in-memory';
import type { VectorStore } from './types';

export type { MemoryEntry, PruneOptions, SearchHit, SearchOptions, VectorStore } from './types';
export { inMemoryVectorStore } from './in-memory';
export type { InMemoryVectorStore } from './in-memory';
export { createRedisVectorStore } from './redis';
export type { RedisVectorStoreOptions } from './redis';

const registry: Map<string, VectorStore> = new Map([
  [inMemoryVectorStore.name, inMemoryVectorStore],
]);

export function registerVectorStore(store: VectorStore): void {
  registry.set(store.name, store);
}

export function getVectorStore(name: string): VectorStore | undefined {
  return registry.get(name);
}

export function listVectorStores(): readonly string[] {
  return Array.from(registry.keys());
}

/**
 * Test-only: register a store and get a teardown function that
 * restores prior state.
 */
export function registerVectorStoreForTest(store: VectorStore): () => void {
  const previous = registry.get(store.name);
  registry.set(store.name, store);
  return () => {
    if (previous === undefined) {
      registry.delete(store.name);
    } else {
      registry.set(store.name, previous);
    }
  };
}
