import type { MemoryEntry, PruneOptions, SearchHit, SearchOptions, VectorStore } from './types';

/**
 * In-process VectorStore for unit tests and the standalone integration
 * smoke. Linear-scan cosine similarity over a Map keyed by entry id;
 * fine for hundreds of entries, not intended for production scale.
 *
 * Maintains its own dimension check: the first upsert in a namespace
 * pins the dimension; subsequent upserts with a different vector size
 * throw, mirroring what the production RedisVectorStore enforces via
 * the FT.CREATE schema.
 */
class InMemoryVectorStore implements VectorStore {
  readonly name = 'in-memory';

  private readonly entries: Map<string, MemoryEntry> = new Map();
  private readonly namespaceDimensions: Map<string, number> = new Map();

  async upsert(entry: MemoryEntry): Promise<void> {
    const expected = this.namespaceDimensions.get(entry.namespace);
    if (expected === undefined) {
      this.namespaceDimensions.set(entry.namespace, entry.vector.length);
    } else if (expected !== entry.vector.length) {
      throw new Error(
        `Namespace '${entry.namespace}' is pinned to ${expected} dimensions; got ${entry.vector.length}`,
      );
    }
    this.entries.set(this.compositeKey(entry.id, entry.namespace), { ...entry });
  }

  async search(opts: SearchOptions): Promise<readonly SearchHit[]> {
    const { namespace, queryVector, topK, minSimilarity } = opts;
    const ranked: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const entry of this.entries.values()) {
      if (entry.namespace !== namespace) continue;
      const score = computeCosineSimilarity(entry.vector, queryVector);
      if (score < minSimilarity) continue;
      ranked.push({ entry, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, topK);
    const now = Date.now();
    for (const { entry } of top) {
      const key = this.compositeKey(entry.id, entry.namespace);
      const stored = this.entries.get(key);
      if (stored !== undefined) {
        this.entries.set(key, { ...stored, lastAccessedAt: now });
      }
    }
    return top.map(({ entry, score }) => ({
      id: entry.id,
      namespace: entry.namespace,
      text: entry.text,
      metadata: entry.metadata,
      score,
    }));
  }

  async touchAccess(id: string, namespace: string): Promise<void> {
    const key = this.compositeKey(id, namespace);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.set(key, { ...entry, lastAccessedAt: Date.now() });
  }

  async prune(opts: PruneOptions): Promise<number> {
    let deleted = 0;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.namespace !== opts.namespace) continue;
      if (entry.lastAccessedAt < opts.olderThanMs) {
        this.entries.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async count(namespace: string): Promise<number> {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.namespace === namespace) total += 1;
    }
    return total;
  }

  async delete(id: string, namespace: string): Promise<boolean> {
    return this.entries.delete(this.compositeKey(id, namespace));
  }

  /** Test-only: drop everything. Useful between test cases. */
  clearForTest(): void {
    this.entries.clear();
    this.namespaceDimensions.clear();
  }

  private compositeKey(id: string, namespace: string): string {
    return `${namespace}::${id}`;
  }
}

function computeCosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Cosine similarity dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let index = 0; index < a.length; index += 1) {
    const aValue = a[index];
    const bValue = b[index];
    if (aValue === undefined || bValue === undefined) {
      throw new Error('unreachable: length-checked above');
    }
    dot += aValue * bValue;
    aMag += aValue * aValue;
    bMag += bValue * bValue;
  }
  const magnitude = Math.sqrt(aMag) * Math.sqrt(bMag);
  if (magnitude === 0) return 0;
  return dot / magnitude;
}

export const inMemoryVectorStore: InMemoryVectorStore = new InMemoryVectorStore();
export type { InMemoryVectorStore };
