import type { SecretProvider, SecretBinding } from './types';

/**
 * Reads secrets from process.env. The `reference` field is the env var name.
 * Provides backward compatibility — every secret that works via env vars
 * today continues working with `provider: "env"`.
 */
export class EnvSecretProvider implements SecretProvider {
  readonly name = 'env';

  async resolve(bindings: readonly SecretBinding[]): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    for (const binding of bindings) {
      const value = process.env[binding.reference];
      if (value !== undefined) {
        result.set(binding.key, value);
      }
    }
    return result;
  }
}
