import { afterEach, describe, expect, it } from 'vitest';

import type {
  InMemoryVectorStore,
  MemoryEntry,
} from '../../../../src/services/memory/vector-store';
import { inMemoryVectorStore } from '../../../../src/services/memory/vector-store';

const NS = 'test-ns';

function makeEntry(id: string, text: string, vector: number[]): MemoryEntry {
  return {
    id,
    namespace: NS,
    text,
    metadata: {},
    vector,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
}

describe('InMemoryVectorStore', () => {
  afterEach(() => {
    (inMemoryVectorStore as unknown as InMemoryVectorStore).clearForTest();
  });

  it('upsert + search round-trip', async () => {
    await inMemoryVectorStore.upsert(makeEntry('a', 'first', [1, 0, 0, 0]));
    await inMemoryVectorStore.upsert(makeEntry('b', 'second', [0, 1, 0, 0]));

    const hits = await inMemoryVectorStore.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 5,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.id).toBe('a');
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    expect(hits[1]!.id).toBe('b');
    expect(hits[1]!.score).toBeCloseTo(0, 5);
  });

  it('respects topK', async () => {
    for (let index = 0; index < 5; index += 1) {
      await inMemoryVectorStore.upsert(makeEntry(`e${index}`, `text-${index}`, [1, 0, 0, 0]));
    }
    const hits = await inMemoryVectorStore.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 3,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(3);
  });

  it('filters out hits below minSimilarity', async () => {
    await inMemoryVectorStore.upsert(makeEntry('a', 'similar', [1, 0, 0, 0]));
    await inMemoryVectorStore.upsert(makeEntry('b', 'orthogonal', [0, 1, 0, 0]));

    const hits = await inMemoryVectorStore.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 5,
      minSimilarity: 0.5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('a');
  });

  it('search bumps lastAccessedAt on returned hits', async () => {
    const oldTime = Date.now() - 1_000_000;
    await inMemoryVectorStore.upsert({
      ...makeEntry('a', 'old', [1, 0, 0, 0]),
      lastAccessedAt: oldTime,
    });

    await inMemoryVectorStore.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 1,
      minSimilarity: 0,
    });

    // Verify by issuing a prune that would have caught the old timestamp
    // but should not catch the now-updated one.
    const deleted = await inMemoryVectorStore.prune({
      namespace: NS,
      olderThanMs: Date.now() - 500_000,
    });
    expect(deleted).toBe(0);
  });

  it('prune deletes only entries older than olderThanMs', async () => {
    const stale = Date.now() - 1_000_000;
    const fresh = Date.now() - 100;

    await inMemoryVectorStore.upsert({
      ...makeEntry('stale', 'old', [1, 0, 0, 0]),
      lastAccessedAt: stale,
    });
    await inMemoryVectorStore.upsert({
      ...makeEntry('fresh', 'new', [0, 1, 0, 0]),
      lastAccessedAt: fresh,
    });

    const deleted = await inMemoryVectorStore.prune({
      namespace: NS,
      olderThanMs: Date.now() - 500_000,
    });
    expect(deleted).toBe(1);
    expect(await inMemoryVectorStore.count(NS)).toBe(1);

    const remaining = await inMemoryVectorStore.search({
      namespace: NS,
      queryVector: [1, 1, 0, 0],
      topK: 5,
      minSimilarity: 0,
    });
    expect(remaining.map((h) => h.id)).toEqual(['fresh']);
  });

  it('count returns per-namespace count only', async () => {
    await inMemoryVectorStore.upsert(makeEntry('a', '...', [1, 0, 0, 0]));
    await inMemoryVectorStore.upsert(makeEntry('b', '...', [0, 1, 0, 0]));
    await inMemoryVectorStore.upsert({
      ...makeEntry('c', '...', [0, 0, 1, 0]),
      namespace: 'other-ns',
    });

    expect(await inMemoryVectorStore.count(NS)).toBe(2);
    expect(await inMemoryVectorStore.count('other-ns')).toBe(1);
    expect(await inMemoryVectorStore.count('does-not-exist')).toBe(0);
  });

  it('rejects vectors with mismatched dimensions for an existing namespace', async () => {
    await inMemoryVectorStore.upsert(makeEntry('a', 'four-dim', [1, 0, 0, 0]));
    await expect(
      inMemoryVectorStore.upsert(makeEntry('b', 'three-dim', [1, 0, 0])),
    ).rejects.toThrow(/4 dimensions; got 3/);
  });

  it('delete removes the entry and search no longer returns it', async () => {
    await inMemoryVectorStore.upsert(makeEntry('a', 'present', [1, 0, 0, 0]));
    expect(await inMemoryVectorStore.delete('a', NS)).toBe(true);
    expect(await inMemoryVectorStore.delete('a', NS)).toBe(false);

    const hits = await inMemoryVectorStore.search({
      namespace: NS,
      queryVector: [1, 0, 0, 0],
      topK: 5,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(0);
  });

  it('touchAccess on missing id is a no-op', async () => {
    await expect(inMemoryVectorStore.touchAccess('missing', NS)).resolves.toBeUndefined();
  });
});
