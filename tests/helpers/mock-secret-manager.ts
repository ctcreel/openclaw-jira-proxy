import { SecretManager } from '../../src/secrets/manager';
import { registerSecretProvider, resetSecretProviders } from '../../src/secrets/registry';
import type { SecretBinding, SecretProvider } from '../../src/secrets/types';

/**
 * Test-only SecretProvider backed by a fixed in-memory map.
 * Use via `buildMockSecretManager` — this class stays internal.
 */
class MockSecretProvider implements SecretProvider {
  readonly name = 'mock';
  readonly values: ReadonlyMap<string, string>;

  constructor(entries: Iterable<[string, string]>) {
    this.values = new Map(entries);
  }

  async resolve(bindings: readonly SecretBinding[]): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    for (const b of bindings) {
      const v = this.values.get(b.key);
      if (v !== undefined) out.set(b.key, v);
    }
    return out;
  }
}

/**
 * Build a real `SecretManager` backed by the `MockSecretProvider` for tests.
 * Every entry becomes a required binding, so `manager.getSecret(key)` returns
 * the staged value synchronously after `initialize()`.
 *
 * Caller owns lifecycle: `await manager.close()` (or `manager.close()`) in
 * `afterEach` to tear down refresh timers.
 */
export async function buildMockSecretManager(
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<SecretManager> {
  resetSecretProviders();
  registerSecretProvider(new MockSecretProvider(entries));
  const bindings: SecretBinding[] = entries.map(([key]) => ({
    key,
    provider: 'mock',
    reference: `ref:${key}`,
    required: true,
  }));
  const manager = new SecretManager(bindings);
  await manager.initialize();
  return manager;
}
