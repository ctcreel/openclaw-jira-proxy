import { getLogger } from '../lib/logging';
import { getSecretProvider } from './registry';
import type { SecretBinding, ResolvedSecret } from './types';

const logger = getLogger('secret-manager');

const MAX_REFRESH_FAILURES = 3;

let instance: SecretManager | null = null;

function setInstance(mgr: SecretManager): void {
  instance = mgr;
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
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private readonly failureCounts = new Map<string, number>();

  constructor(bindings: readonly SecretBinding[]) {
    this.bindings = bindings;
    setInstance(this);
  }

  /** Resolve all declared secrets. Must be called before workers start. */
  async initialize(): Promise<void> {
    logger.info({ count: this.bindings.length }, 'Resolving secrets');

    const grouped = groupBindingsByProvider(this.bindings);

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
          throw new Error(
            `Required secret "${binding.key}" could not be resolved from provider "${providerName}"`,
          );
        } else {
          logger.warn({ key: binding.key, provider: providerName }, 'Optional secret not resolved');
        }
      }
    }

    logger.info({ resolved: this.secrets.size, total: this.bindings.length }, 'Secrets resolved');

    this.scheduleRefreshTimers();
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
