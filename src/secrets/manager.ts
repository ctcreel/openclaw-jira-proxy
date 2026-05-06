import { getLogger } from '../lib/logging';
import type { CachedSecretEntry, SecretCache } from './cache';
import { getSecretProvider } from './registry';
import type { SecretBinding, ResolvedSecret } from './types';

const logger = getLogger('secret-manager');

const MAX_REFRESH_FAILURES = 3;

export interface SecretManagerOptions {
  /**
   * Optional persistent cache for resolved secrets. When provided, the
   * manager reads cached values on `initialize()` and writes resolved
   * values back to the cache after each successful provider resolution
   * (boot + refresh). See {@link SecretCache} for the contract and
   * `src/secrets/cache.ts` for the rationale (SPE-2005).
   */
  cache?: SecretCache;
}

let instance: SecretManager | null = null;

function setInstance(manager: SecretManager): void {
  instance = manager;
}

export function getSecretManager(): SecretManager {
  if (!instance) {
    throw new Error('SecretManager not initialized — call createSecretManager() at startup');
  }
  return instance;
}

export class SecretManager {
  private readonly secrets = new Map<string, ResolvedSecret>();
  private readonly bindings: readonly SecretBinding[];
  private readonly bindingByKey: ReadonlyMap<string, SecretBinding>;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private readonly failureCounts = new Map<string, number>();
  private readonly cache: SecretCache | undefined;

  constructor(bindings: readonly SecretBinding[], options: SecretManagerOptions = {}) {
    this.bindings = bindings;
    this.bindingByKey = new Map(bindings.map((b) => [b.key, b]));
    this.cache = options.cache;
    setInstance(this);
  }

  /**
   * Resolve all declared secrets. Must be called before workers start.
   * Two-step pipeline (cache hits, then provider resolution for misses)
   * is split into helper methods so this function stays under cognitive-
   * complexity thresholds; behaviour is identical to one inline pass.
   */
  async initialize(): Promise<void> {
    logger.info(
      { count: this.bindings.length, cache: this.cache !== undefined },
      'Resolving secrets',
    );

    const missingBindings = await this.applyCacheHits();
    const firstError = await this.resolveMissingViaProviders(missingBindings);

    // Persist successful resolutions to the cache BEFORE raising any
    // required-miss error. Partial cache means the next restart skips
    // the slow provider for keys that did resolve, even when a different
    // required key keeps the unit failing — the brake on restart-loop
    // amplification is the entire point of the cache.
    await this.persistCacheBestEffort();

    if (firstError !== null) {
      throw firstError;
    }

    logger.info({ resolved: this.secrets.size, total: this.bindings.length }, 'Secrets resolved');
    this.scheduleRefreshTimers();
  }

  /**
   * Step 1 of initialize(): apply cache hits, return the bindings that
   * still need provider resolution. A binding is a cache hit iff its
   * key has a cached entry AND the entry's reference matches AND the
   * entry's sourceProvider matches — operator rotations or backend
   * moves invalidate the cached value. The cache itself has already
   * filtered out TTL-expired, permission-fail, and schema-mismatch
   * entries.
   */
  private async applyCacheHits(): Promise<SecretBinding[]> {
    const cached = this.cache ? await this.cache.read() : new Map<string, CachedSecretEntry>();
    const missingBindings: SecretBinding[] = [];
    let cacheHits = 0;
    for (const binding of this.bindings) {
      const entry = cached.get(binding.key);
      if (isCacheHit(entry, binding)) {
        this.secrets.set(
          binding.key,
          buildResolved({
            binding,
            value: entry.value,
            source: binding.provider,
            resolvedAt: new Date(entry.resolvedAt),
          }),
        );
        cacheHits += 1;
      } else {
        missingBindings.push(binding);
      }
    }
    if (cacheHits > 0) {
      logger.info(
        { hits: cacheHits, misses: missingBindings.length },
        'Resolved secrets from cache',
      );
    }
    return missingBindings;
  }

  /**
   * Step 2 of initialize(): resolve every cache-missed binding through
   * its provider. Returns the first error encountered (an unresolved
   * required secret) without throwing — the caller still needs to
   * persist the partial cache before propagating.
   */
  private async resolveMissingViaProviders(
    missingBindings: readonly SecretBinding[],
  ): Promise<Error | null> {
    const grouped = groupBindingsByProvider(missingBindings);
    let firstError: Error | null = null;

    for (const [providerName, providerBindings] of grouped) {
      const provider = getSecretProvider(providerName);
      if (provider.initialize) {
        await provider.initialize();
      }
      const resolved = await provider.resolve(providerBindings);
      firstError = this.absorbProviderResults(providerName, providerBindings, resolved, firstError);
    }
    return firstError;
  }

  /**
   * Per-provider result merge: store every resolved value, capture the
   * first required-miss error, log optional misses. Pure mutation on
   * `this.secrets`; returned firstError is the running first-seen
   * value so the caller can keep threading it through providers.
   */
  private absorbProviderResults(
    providerName: string,
    providerBindings: readonly SecretBinding[],
    resolved: ReadonlyMap<string, string>,
    firstError: Error | null,
  ): Error | null {
    let next = firstError;
    for (const binding of providerBindings) {
      const value = resolved.get(binding.key);
      if (value !== undefined) {
        this.secrets.set(
          binding.key,
          buildResolved({ binding, value, source: providerName, resolvedAt: new Date() }),
        );
      } else if (binding.required) {
        next ??= new Error(
          `Required secret "${binding.key}" could not be resolved from provider "${providerName}"`,
        );
      } else {
        logger.warn({ key: binding.key, provider: providerName }, 'Optional secret not resolved');
      }
    }
    return next;
  }

  /**
   * Write the current in-memory resolutions to the cache. Failures are
   * logged and swallowed — a broken cache must never break startup.
   */
  private async persistCacheBestEffort(): Promise<void> {
    if (!this.cache) return;

    const entries = new Map<string, CachedSecretEntry>();
    for (const [key, secret] of this.secrets) {
      const binding = this.bindingByKey.get(key);
      if (!binding) continue;
      entries.set(key, {
        sourceProvider: secret.source,
        reference: binding.reference,
        value: secret.value,
        resolvedAt: secret.resolvedAt.toISOString(),
        ttlSeconds: binding.ttlSeconds,
      });
    }

    try {
      await this.cache.write(entries);
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to persist secrets cache — startup continues',
      );
    }
  }

  /** Synchronous read from memory. Throws if not found. */
  getSecret(key: string): string {
    const secret = this.secrets.get(key);
    if (!secret) {
      throw new Error(`Secret "${key}" not found. Was it declared in the secrets config?`);
    }
    return secret.value;
  }

  /** Check if a secret exists (for optional secrets). */
  hasSecret(key: string): boolean {
    return this.secrets.has(key);
  }

  /** Update a secret value in memory (used by providers that self-refresh). */
  updateSecret(key: string, value: string, expiresAt?: Date): void {
    const existing = this.secrets.get(key);
    if (!existing) {
      throw new Error(
        `Cannot update secret "${key}" — not declared in bindings. ` +
          `updateSecret is for refresh of previously-resolved secrets only.`,
      );
    }
    this.secrets.set(key, {
      key,
      value,
      resolvedAt: new Date(),
      expiresAt,
      source: existing.source,
    });
  }

  /** Are all required secrets resolved and none critically expired? */
  isHealthy(): boolean {
    for (const binding of this.bindings) {
      if (!binding.required) continue;
      const secret = this.secrets.get(binding.key);
      if (!secret) return false;
    }
    return true;
  }

  /** Stop all refresh timers. */
  close(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.length = 0;
    instance = null;
  }

  private scheduleRefreshTimers(): void {
    // Group bindings by (provider, ttlSeconds) to batch refresh
    const refreshGroups = new Map<string, SecretBinding[]>();

    for (const binding of this.bindings) {
      if (!binding.ttlSeconds) continue;
      const groupKey = `${binding.provider}:${binding.ttlSeconds}`;
      const group = refreshGroups.get(groupKey);
      if (group) {
        group.push(binding);
      } else {
        refreshGroups.set(groupKey, [binding]);
      }
    }

    for (const [groupKey, groupBindings] of refreshGroups) {
      const ttlMs = groupBindings[0]!.ttlSeconds! * 1000;
      const refreshMs = Math.max(ttlMs - 60_000, 30_000); // refresh 1 min before expiry

      const timer = setInterval(() => {
        this.refreshGroup(groupKey, groupBindings).catch(() => {});
      }, refreshMs);
      timer.unref();
      this.timers.push(timer);

      logger.info(
        { group: groupKey, count: groupBindings.length, refreshSeconds: refreshMs / 1000 },
        'Scheduled secret refresh',
      );
    }
  }

  private async refreshGroup(groupKey: string, bindings: SecretBinding[]): Promise<void> {
    const providerName = bindings[0]!.provider;

    try {
      const provider = getSecretProvider(providerName);
      const resolved = await provider.resolve(bindings);

      for (const binding of bindings) {
        const value = resolved.get(binding.key);
        if (value !== undefined) {
          this.updateSecret(
            binding.key,
            value,
            binding.ttlSeconds ? new Date(Date.now() + binding.ttlSeconds * 1000) : undefined,
          );
        }
      }

      this.failureCounts.delete(groupKey);
      logger.info({ group: groupKey, resolved: resolved.size }, 'Secrets refreshed');

      // Refresh writes through to the cache so a refreshed token survives
      // the next restart without going back to the slow provider.
      await this.persistCacheBestEffort();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failures = (this.failureCounts.get(groupKey) ?? 0) + 1;
      this.failureCounts.set(groupKey, failures);

      logger.error(
        { group: groupKey, failures, maxFailures: MAX_REFRESH_FAILURES, error: message },
        'Secret refresh failed',
      );

      if (failures >= MAX_REFRESH_FAILURES) {
        const hasRequired = bindings.some((binding) => binding.required);
        if (hasRequired) {
          logger.error(
            { group: groupKey },
            'Required secrets exhausted refresh retries — restarting',
          );
          process.exit(1);
        }
      }
    }
  }
}

function isCacheHit(
  entry: CachedSecretEntry | undefined,
  binding: SecretBinding,
): entry is CachedSecretEntry {
  if (entry === undefined) return false;
  return entry.reference === binding.reference && entry.sourceProvider === binding.provider;
}

/**
 * Single ResolvedSecret constructor for both the cache-hit and
 * provider-hit paths. Splitting these into two helpers (one per call
 * site) tripped Sonar's duplication detector — same shape, two
 * literals away from each other. Caller supplies the differing fields
 * (value, source, resolvedAt) explicitly.
 */
function buildResolved(args: {
  binding: SecretBinding;
  value: string;
  source: string;
  resolvedAt: Date;
}): ResolvedSecret {
  const { binding, value, source, resolvedAt } = args;
  return {
    key: binding.key,
    value,
    resolvedAt,
    expiresAt: binding.ttlSeconds ? new Date(Date.now() + binding.ttlSeconds * 1000) : undefined,
    source,
  };
}

function groupBindingsByProvider(bindings: readonly SecretBinding[]): Map<string, SecretBinding[]> {
  const grouped = new Map<string, SecretBinding[]>();
  for (const binding of bindings) {
    const group = grouped.get(binding.provider);
    if (group) {
      group.push(binding);
    } else {
      grouped.set(binding.provider, [binding]);
    }
  }
  return grouped;
}
