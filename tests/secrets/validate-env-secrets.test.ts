import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { ProviderConfig } from '../../src/config';
import { SecretManager } from '../../src/secrets/manager';
import { registerSecretProvider, resetSecretProviders } from '../../src/secrets/registry';
import type { SecretProvider, SecretBinding } from '../../src/secrets/types';
import { validateProviderEnvSecrets } from '../../src/secrets/validate-env-secrets';

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

async function buildManager(
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

const baseProvider: ProviderConfig = {
  name: 'jira',
  routePath: '/hooks/jira',
  hmacSecret: 'test-hmac',
  signatureStrategy: 'websub',
};

describe('validateProviderEnvSecrets', () => {
  let manager: SecretManager | null = null;

  beforeEach(() => {
    manager = null;
  });

  afterEach(() => {
    if (manager) manager.close();
  });

  it('is a no-op when no provider declares envSecrets', async () => {
    manager = await buildManager([]);
    expect(() => validateProviderEnvSecrets([baseProvider], manager!)).not.toThrow();
  });

  it('succeeds when every declared key is known to SecretManager', async () => {
    manager = await buildManager([['jira_patch_token', 'tok']]);
    const provider: ProviderConfig = { ...baseProvider, envSecrets: ['jira_patch_token'] };
    expect(() => validateProviderEnvSecrets([provider], manager!)).not.toThrow();
  });

  it('throws when any declared key is not known to SecretManager', async () => {
    manager = await buildManager([['jira_patch_token', 'tok']]);
    const provider: ProviderConfig = {
      ...baseProvider,
      envSecrets: ['jira_patch_token', 'missing_key'],
    };
    expect(() => validateProviderEnvSecrets([provider], manager!)).toThrow(/jira:missing_key/);
  });

  it('aggregates all missing keys across providers into one error', async () => {
    manager = await buildManager([['known_key', 'x']]);
    const providerA: ProviderConfig = {
      ...baseProvider,
      name: 'a',
      envSecrets: ['missing_a'],
    };
    const providerB: ProviderConfig = {
      ...baseProvider,
      name: 'b',
      envSecrets: ['missing_b'],
    };
    expect(() => validateProviderEnvSecrets([providerA, providerB], manager!)).toThrow(
      /a:missing_a.*b:missing_b/,
    );
  });
});
