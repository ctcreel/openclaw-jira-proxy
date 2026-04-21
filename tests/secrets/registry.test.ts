import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerSecretProvider,
  getSecretProvider,
  getRegisteredSecretProviders,
  resetSecretProviders,
} from '../../src/secrets/registry';
import { EnvSecretProvider } from '../../src/secrets/env.provider';
import type { SecretProvider } from '../../src/secrets/types';

class FakeProvider implements SecretProvider {
  readonly name = 'fake';
  async resolve(): Promise<ReadonlyMap<string, string>> {
    return new Map();
  }
}

describe('Secret Provider Registry', () => {
  beforeEach(() => {
    resetSecretProviders();
  });

  it('should register and retrieve a provider by name', () => {
    const provider = new EnvSecretProvider();
    registerSecretProvider(provider);
    expect(getSecretProvider('env')).toBe(provider);
  });

  it('should throw for unknown provider name', () => {
    expect(() => getSecretProvider('nonexistent')).toThrow('Unknown secret provider');
  });

  it('should list all registered providers', () => {
    registerSecretProvider(new EnvSecretProvider());
    registerSecretProvider(new FakeProvider());
    const providers = getRegisteredSecretProviders();
    expect(providers).toHaveLength(2);
  });

  it('should clear all providers on reset', () => {
    registerSecretProvider(new EnvSecretProvider());
    resetSecretProviders();
    expect(() => getSecretProvider('env')).toThrow();
    expect(getRegisteredSecretProviders()).toHaveLength(0);
  });
});
