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

  /** Resolve all declared secrets. Must be called before workers start. */
  async initialize(): Promise<void> {
    logger.info(
      { count: this.bindings.length, cache: this.cache !== undefined },
      'Resolving secrets',
    );

    // Step 1 — apply cache hits first. A binding is a cache hit iff (a) its
    // key has a cached entry, (b) the entry's reference matches the
    // binding's current reference (operator may have rotated the locator),
    // and (c) the entry's sourceProvider matches the binding's provider
    // (operator may have moved the key to a different backend). The
    // cache-side TTL/permission/schema checks have already filtered out
    // stale or untrusted entries.
    const cached = this.cache ? await this.cache.read() : new Map<string, CachedSecretEntry>();
    const missingBindings: SecretBinding[] = [];
    let cacheHits = 0;
    for (const binding of this.bindings) {
      const entry = cached.get(binding.key);
      if (
        entry !== undefined &&
        entry.reference === binding.reference &&
        entry.sourceProvider === binding.provider
      ) {
        this.secrets.set(binding.key, {
          key: binding.key,
          value: entry.value,
          resolvedAt: new Date(entry.resolvedAt),
          expiresAt: binding.ttlSeconds
            ? new Date(Date.now() + binding.ttlSeconds * 1000)
            : undefined,
          source: binding.provider,
        });
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

    // Step 2 — resolve cache misses via providers. The error from the first
    // unresolved required secret is captured but not thrown until after the
    // partial cache write below — successful resolutions on this boot must
    // survive the next restart even when one required secret fails.
    const grouped = groupBindingsByProvider(missingBindings);
    let firstError: Error | null = null;

    for (const [providerName, providerBindings] of grouped) {
      const provider = getSecretProvider(providerName);
      if (provider.initialize) {
        await provider.initialize();
      }

      const resolved = await provider.resolve(providerBindings);

      for (const binding of providerBindings) {
        const value = resolved.get(binding.key);
        if (value !== undefined) {
          this.secrets.set(binding.key, {
            key: binding.key,
            value,
            resolvedAt: new Date(),
            expiresAt: binding.ttlSeconds
              ? new Date(Date.now() + binding.ttlSeconds * 1000)
              : undefined,
            source: providerName,
          });
        } else if (binding.required) {
          if (firstError === null) {
            firstError = new Error(
              `Required secret "${binding.key}" could not be resolved from provider "${providerName}"`,
            );
          }
        } else {
          logger.warn({ key: binding.key, provider: providerName }, 'Optional secret not resolved');
        }
      }
    }

    // Step 3 — persist successful resolutions to the cache before raising
    // the first required-miss error. A partial cache lets the next restart
    // skip the slow provider for keys that did resolve, even if a different
    // required key keeps the unit failing — that is the entire point of
    // the cache as a brake on restart-loop amplification.
    await this.persistCacheBestEffort();

    if (firstError !== null) {
      throw firstError;
    }

    logger.info({ resolved: this.secrets.size, total: this.bindings.length }, 'Secrets resolved');

    this.scheduleRefreshTimers();
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
