/**
 * Per-namespace configuration. Set once at startup from the agent's
 * `clawndom.yaml` `memory.namespaces.<name>` block.
 */
export interface NamespaceConfig {
  readonly name: string;
  readonly embeddingProviderName: string;
  readonly vectorStoreName: string;
  /** Milliseconds after `lastAccessedAt` before an entry is eligible for prune. */
  readonly pruneAfterMs: number;
  /** Maximum store calls per agent run (per traceId) for this namespace. */
  readonly maxStoresPerRun: number;
}

export interface StoreInput {
  readonly namespace: string;
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
  /** Identifies the agent run for per-run rate limiting. */
  readonly traceId: string;
}

export interface StoreOutput {
  readonly id: string;
  readonly namespace: string;
}

export interface SearchInput {
  readonly namespace: string;
  readonly query: string;
  readonly topK?: number;
  readonly minSimilarity?: number;
  readonly traceId?: string;
}

export interface SearchOutput {
  readonly hits: readonly {
    readonly id: string;
    readonly text: string;
    readonly metadata: Record<string, unknown>;
    readonly score: number;
  }[];
}

export interface DeleteInput {
  readonly namespace: string;
  readonly id: string;
}

export interface PruneInput {
  readonly namespace: string;
}

export interface PruneOutput {
  readonly namespace: string;
  readonly deletedCount: number;
  readonly durationMs: number;
}

/**
 * Typed errors so the HTTP controller can map to appropriate status codes
 * without string-matching messages.
 */
export class UnknownNamespaceError extends Error {
  constructor(namespace: string) {
    super(`Unknown memory namespace: ${namespace}`);
    this.name = 'UnknownNamespaceError';
  }
}

export class RateLimitExceededError extends Error {
  constructor(namespace: string, traceId: string, limit: number) {
    super(
      `Memory store rate limit exceeded for namespace '${namespace}' (traceId=${traceId}, limit=${limit})`,
    );
    this.name = 'RateLimitExceededError';
  }
}

export class ProviderNotRegisteredError extends Error {
  constructor(kind: 'embedding' | 'vector-store', name: string) {
    super(`No ${kind} provider registered with name '${name}'`);
    this.name = 'ProviderNotRegisteredError';
  }
}
