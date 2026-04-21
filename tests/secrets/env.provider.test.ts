import { describe, it, expect, afterEach } from 'vitest';

import { EnvSecretProvider } from '../../src/secrets/env.provider';
import type { SecretBinding } from '../../src/secrets/types';

describe('EnvSecretProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should have name "env"', () => {
    const provider = new EnvSecretProvider();
    expect(provider.name).toBe('env');
  });

  it('should resolve secrets from process.env', async () => {
    process.env.TEST_SECRET = 'test-value';
    const provider = new EnvSecretProvider();
    const bindings: SecretBinding[] = [
      { key: 'my_secret', provider: 'env', reference: 'TEST_SECRET', required: true },
    ];
    const result = await provider.resolve(bindings);
    expect(result.get('my_secret')).toBe('test-value');
  });

  it('should omit missing env vars from result', async () => {
    delete process.env.MISSING_VAR;
    const provider = new EnvSecretProvider();
    const bindings: SecretBinding[] = [
      { key: 'missing', provider: 'env', reference: 'MISSING_VAR', required: true },
    ];
    const result = await provider.resolve(bindings);
    expect(result.has('missing')).toBe(false);
  });

  it('should resolve multiple bindings', async () => {
    process.env.SECRET_A = 'value-a';
    process.env.SECRET_B = 'value-b';
    const provider = new EnvSecretProvider();
    const bindings: SecretBinding[] = [
      { key: 'a', provider: 'env', reference: 'SECRET_A', required: true },
      { key: 'b', provider: 'env', reference: 'SECRET_B', required: true },
    ];
    const result = await provider.resolve(bindings);
    expect(result.get('a')).toBe('value-a');
    expect(result.get('b')).toBe('value-b');
  });
});
