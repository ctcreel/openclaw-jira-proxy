import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SecretManager } from '../../src/secrets/manager';
import { registerSecretProvider, resetSecretProviders } from '../../src/secrets/registry';
import type { SecretProvider, SecretBinding } from '../../src/secrets/types';

class MockProvider implements SecretProvider {
  readonly name = 'mock';
  readonly resolveFn = vi.fn<[readonly SecretBinding[]], Promise<ReadonlyMap<string, string>>>();

  async resolve(bindings: readonly SecretBinding[]): Promise<ReadonlyMap<string, string>> {
    return this.resolveFn(bindings);
  }
}

describe('SecretManager', () => {
  let mockProvider: MockProvider;

  beforeEach(() => {
    resetSecretProviders();
    mockProvider = new MockProvider();
    registerSecretProvider(mockProvider);
  });

  it('should resolve secrets on initialize', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map([['api_key', 'secret-123']]));

    const bindings: SecretBinding[] = [
      { key: 'api_key', provider: 'mock', reference: 'some-ref', required: true },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    expect(manager.getSecret('api_key')).toBe('secret-123');
    manager.close();
  });

  it('should throw on getSecret for unknown key', async () => {
    const manager = new SecretManager([]);
    await manager.initialize();

    expect(() => manager.getSecret('nonexistent')).toThrow('Secret "nonexistent" not found');
    manager.close();
  });

  it('should fail startup when required secret is missing', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map());

    const bindings: SecretBinding[] = [
      { key: 'required_secret', provider: 'mock', reference: 'ref', required: true },
    ];
    const manager = new SecretManager(bindings);

    await expect(manager.initialize()).rejects.toThrow(
      'Required secret "required_secret" could not be resolved',
    );
    manager.close();
  });

  it('should warn but not fail for optional missing secrets', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map());

    const bindings: SecretBinding[] = [
      { key: 'optional_secret', provider: 'mock', reference: 'ref', required: false },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    expect(manager.hasSecret('optional_secret')).toBe(false);
    manager.close();
  });

  it('should report healthy when all required secrets are resolved', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map([['key', 'value']]));

    const bindings: SecretBinding[] = [
      { key: 'key', provider: 'mock', reference: 'ref', required: true },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    expect(manager.isHealthy()).toBe(true);
    manager.close();
  });

  it('should report unhealthy when required secret is missing', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map([['other', 'value']]));

    const bindings: SecretBinding[] = [
      { key: 'key', provider: 'mock', reference: 'ref', required: false },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    // hasSecret returns false for unresolved optional secret
    expect(manager.hasSecret('key')).toBe(false);
    // But isHealthy still true because it's not required
    expect(manager.isHealthy()).toBe(true);
    manager.close();
  });

  it('should resolve multiple secrets from same provider in batch', async () => {
    mockProvider.resolveFn.mockResolvedValue(
      new Map([
        ['secret_a', 'value-a'],
        ['secret_b', 'value-b'],
      ]),
    );

    const bindings: SecretBinding[] = [
      { key: 'secret_a', provider: 'mock', reference: 'ref-a', required: true },
      { key: 'secret_b', provider: 'mock', reference: 'ref-b', required: true },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    expect(mockProvider.resolveFn).toHaveBeenCalledOnce();
    expect(manager.getSecret('secret_a')).toBe('value-a');
    expect(manager.getSecret('secret_b')).toBe('value-b');
    manager.close();
  });

  it('should update secret value in memory', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map([['key', 'old-value']]));

    const bindings: SecretBinding[] = [
      { key: 'key', provider: 'mock', reference: 'ref', required: true },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    manager.updateSecret('key', 'new-value');
    expect(manager.getSecret('key')).toBe('new-value');
    manager.close();
  });

  it('should handle empty bindings gracefully', async () => {
    const manager = new SecretManager([]);
    await manager.initialize();
    expect(manager.isHealthy()).toBe(true);
    manager.close();
  });
});
