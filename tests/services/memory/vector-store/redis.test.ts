import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type IORedis from 'ioredis';

import { createRedisVectorStore } from '../../../../src/services/memory/vector-store/redis';
import type { MemoryEntry, VectorStore } from '../../../../src/services/memory/vector-store';

const NS = 'test-ns';

function makeEntry(id: string, vector: number[], lastAccessedAt = Date.now()): MemoryEntry {
  return {
    id,
    namespace: NS,
    text: `text-${id}`,
    metadata: { source: 'test' },
    vector,
    createdAt: Date.now(),
    lastAccessedAt,
  };
}

describe('RedisVectorStore', () => {
  let redis: IORedis;
  let store: VectorStore;

  beforeEach(() => {
    redis = new RedisMock() as unknown as IORedis;
    store = createRedisVectorStore({ redis });
  });

  afterEach(async () => {
    await redis.flushall();
    await redis.quit();
  });

  it('upsert + search round-trip', async () => {
    await store.upsert(makeEntry('a', [1, 0, 0, 0]));
    await store.upsert(makeEntry('b', [0, 1, 0, 0]));

    const hits = await store.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 5,
      minSimilarity: -1,
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.id).toBe('a');
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  it('preserves text and metadata in hits', async () => {
    await store.upsert({
      id: 'meta-test',
      namespace: NS,
      text: 'hello world',
      metadata: { tag: 'greeting', priority: 5 },
      vector: [1, 0, 0, 0],
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    const hits = await store.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 1,
      minSimilarity: 0,
    });
    expect(hits[0]?.text).toBe('hello world');
    expect(hits[0]?.metadata).toEqual({ tag: 'greeting', priority: 5 });
  });

  it('respects topK', async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.upsert(makeEntry(`e${index}`, [1, 0, 0, 0]));
    }
    const hits = await store.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 3,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(3);
  });

  it('filters by minSimilarity', async () => {
    await store.upsert(makeEntry('similar', [1, 0, 0, 0]));
    await store.upsert(makeEntry('orthogonal', [0, 1, 0, 0]));
    const hits = await store.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 5,
      minSimilarity: 0.5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('similar');
  });

  it('search bumps lastAccessedAt on returned hits', async () => {
    const oldTime = Date.now() - 1_000_000;
    await store.upsert(makeEntry('a', [1, 0, 0, 0], oldTime));
    await store.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 1,
      minSimilarity: 0,
    });
    const deleted = await store.prune({
      namespace: NS,
      olderThanMs: Date.now() - 500_000,
    });
    expect(deleted).toBe(0);
  });

  it('prune deletes entries older than olderThanMs', async () => {
    const stale = Date.now() - 1_000_000;
    const fresh = Date.now() - 100;
    await store.upsert(makeEntry('stale', [1, 0, 0, 0], stale));
    await store.upsert(makeEntry('fresh', [0, 1, 0, 0], fresh));

    const deleted = await store.prune({
      namespace: NS,
      olderThanMs: Date.now() - 500_000,
    });
    expect(deleted).toBe(1);
    expect(await store.count(NS)).toBe(1);

    const remaining = await store.search({
      namespace: NS,
      queryVector: [1, 1, 0, 0],
      topK: 5,
      minSimilarity: -1,
    });
    expect(remaining.map((h) => h.id)).toEqual(['fresh']);
  });

  it('count returns per-namespace count', async () => {
    await store.upsert(makeEntry('a', [1, 0, 0, 0]));
    await store.upsert(makeEntry('b', [0, 1, 0, 0]));
    await store.upsert({
      ...makeEntry('c', [0, 0, 1, 0]),
      namespace: 'other-ns',
    });
    expect(await store.count(NS)).toBe(2);
    expect(await store.count('other-ns')).toBe(1);
    expect(await store.count('does-not-exist')).toBe(0);
  });

  it('rejects mismatched dimensions on subsequent upsert in same namespace', async () => {
    await store.upsert(makeEntry('a', [1, 0, 0, 0]));
    await expect(store.upsert(makeEntry('b', [1, 0, 0]))).rejects.toThrow(/4 dimensions; got 3/);
  });

  it('delete removes entry and updates the index', async () => {
    await store.upsert(makeEntry('a', [1, 0, 0, 0]));
    expect(await store.delete('a', NS)).toBe(true);
    expect(await store.delete('a', NS)).toBe(false);
    expect(await store.count(NS)).toBe(0);

    const hits = await store.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 5,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(0);
  });

  it('touchAccess on missing id is a no-op', async () => {
    await expect(store.touchAccess('missing', NS)).resolves.toBeUndefined();
  });

  it('touchAccess updates the timestamp of a present entry', async () => {
    const oldTime = Date.now() - 1_000_000;
    await store.upsert(makeEntry('a', [1, 0, 0, 0], oldTime));

    await store.touchAccess('a', NS);
    const deleted = await store.prune({
      namespace: NS,
      olderThanMs: Date.now() - 500_000,
    });
    expect(deleted).toBe(0);
  });
});
