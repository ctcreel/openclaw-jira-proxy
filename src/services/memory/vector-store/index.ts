import { inMemoryVectorStore } from './in-memory';
import type { VectorStore } from './types';

export type { MemoryEntry, PruneOptions, SearchHit, SearchOptions, VectorStore } from './types';
export { inMemoryVectorStore } from './in-memory';
export type { InMemoryVectorStore } from './in-memory';
export { createRedisVectorStore } from './redis';
export type { RedisVectorStoreOptions } from './redis';

const KNOWN_STORE_NAMES: readonly string[] = ['in-memory', 'redis'];

const registry: Map<string, VectorStore> = new Map([
  [inMemoryVectorStore.name, inMemoryVectorStore],
]);

export function registerVectorStore(store: VectorStore): void {
  registry.set(store.name, store);
}

export function getVectorStore(name: string): VectorStore | undefined {
  return registry.get(name);
}

/**
 * All vector-store names Clawndom recognizes — used by config validation,
 * NOT runtime resolution. Superset of currently-instantiated stores.
 */
export function listVectorStores(): readonly string[] {
  return KNOWN_STORE_NAMES;
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
