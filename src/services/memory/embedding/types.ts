/**
 * Strategy interface for text → vector embedding.
 *
 * Implementations wrap a specific embedding backend (OpenAI, local
 * sentence-transformers, fake-for-tests). The MemoryService composes a
 * registered EmbeddingProvider with a registered VectorStore to handle
 * the full store/search flow without knowing which backend is in use.
 *
 * Implementations MUST be deterministic for the same input: a given text
 * yields the same vector across calls within a single process lifetime.
 * Across processes, OpenAI and local models satisfy this naturally; the
 * null-fake provider hashes the input.
 */
export interface EmbeddingProvider {
  /**
   * Registry key used by namespace config to select this provider
   * (e.g. `'openai'`, `'null-fake'`).
   */
  readonly name: string;

  /**
   * Output vector size. Fixed per provider — namespaces store this at
   * creation time and reject mismatches at query time. Changing provider
   * on an existing namespace is an offline re-embed, not in scope here.
   */
  readonly dimensions: number;

  /** Embed a single piece of text. Resolves with a `dimensions`-length array. */
  embed(text: string): Promise<number[]>;

  /**
   * Embed multiple texts in one round-trip. Returns one vector per input,
   * preserving order. Empty array in → empty array out. Implementations
   * SHOULD batch the underlying API call (it's the whole point of the
   * separate method) but MAY fall back to sequential `embed` calls.
   */
  embedBatch(texts: readonly string[]): Promise<number[][]>;
}
