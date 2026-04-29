/**
 * A single memory entry stored in a VectorStore.
 *
 * `vector` is the embedded representation of `text`; the embedding
 * happens upstream (in MemoryService) so the VectorStore is agnostic
 * to which embedding provider produced it. The vector's dimension is
 * implicit — set at namespace creation time and verified by the store
 * implementation.
 *
 * Timestamps are millisecond epoch integers for cross-language
 * compatibility (Redis HSET stores them as strings; sqlite stores as
 * INTEGER; in-memory uses raw numbers).
 */
export interface MemoryEntry {
  readonly id: string;
  readonly namespace: string;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
  readonly vector: readonly number[];
  readonly createdAt: number;
  readonly lastAccessedAt: number;
}

export interface SearchOptions {
  readonly namespace: string;
  readonly queryVector: readonly number[];
  readonly topK: number;
  readonly minSimilarity: number;
}

export interface SearchHit {
  readonly id: string;
  readonly namespace: string;
  readonly text: string;
  readonly metadata: Record<string, unknown>;
  readonly score: number;
}

export interface PruneOptions {
  readonly namespace: string;
  /** Entries with `lastAccessedAt < olderThanMs` are deleted. */
  readonly olderThanMs: number;
}

/**
 * Strategy interface for persistent vector storage and semantic search.
 *
 * Implementations wrap a specific store (Redis with RediSearch, sqlite-vec,
 * an in-memory map for tests). The MemoryService composes a registered
 * VectorStore with a registered EmbeddingProvider to handle store/search
 * without knowing which backend is in use.
 *
 * All operations are scoped by `namespace`. A single VectorStore instance
 * MAY serve many namespaces; cross-namespace search is not supported by
 * this interface — that is a higher-level decision and would need a
 * different surface.
 */
export interface VectorStore {
  /** Registry key (e.g. `'redis'`, `'in-memory'`, `'sqlite-vec'`). */
  readonly name: string;

  /**
   * Insert or replace an entry. Idempotent on `id`. Implementations
   * MUST reject vectors whose dimension doesn't match the namespace's
   * declared dimension (set at first upsert in the namespace).
   */
  upsert(entry: MemoryEntry): Promise<void>;

  /**
   * KNN search within `namespace`. Returns hits ranked by cosine
   * similarity descending. Filters out hits below `minSimilarity`.
   * Returns empty array when the namespace has no entries or all
   * entries fall below the floor.
   *
   * Hits MUST have their `lastAccessedAt` updated to the current time
   * via `touchAccess` before this method returns. (Implementations MAY
   * batch the touch call internally for efficiency.)
   */
  search(opts: SearchOptions): Promise<readonly SearchHit[]>;

  /**
   * Bump `lastAccessedAt` to the current time on a single entry.
   * No-op when the entry doesn't exist.
   */
  touchAccess(id: string, namespace: string): Promise<void>;

  /**
   * Delete entries in `namespace` whose `lastAccessedAt` is older than
   * the configured threshold. Returns the count of entries deleted.
   */
  prune(opts: PruneOptions): Promise<number>;

  /** Number of entries currently in `namespace`. For observability. */
  count(namespace: string): Promise<number>;

  /**
   * Delete a single entry by id. Returns true when the entry existed
   * and was deleted, false when it didn't exist.
   */
  delete(id: string, namespace: string): Promise<boolean>;
}
