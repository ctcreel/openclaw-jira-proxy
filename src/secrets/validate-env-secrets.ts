import type { ProviderConfig } from '../config';
import type { SecretManager } from './manager';

/**
 * Fail fast at startup if any provider declares envSecrets that SecretManager
 * doesn't know about. Without this, the error surfaces only when a webhook
 * fires — hours or days after deploy — which is far too late.
 */
export function validateProviderEnvSecrets(
  providers: readonly ProviderConfig[],
  secretManager: SecretManager,
): void {
  const missing: Array<{ provider: string; key: string }> = [];
  for (const provider of providers) {
    if (!provider.envSecrets || provider.envSecrets.length === 0) {
      continue;
    }
    for (const key of provider.envSecrets) {
      if (!secretManager.hasSecret(key)) {
        missing.push({ provider: provider.name, key });
      }
    }
  }
  if (missing.length > 0) {
    const details = missing.map((m) => `${m.provider}:${m.key}`).join(', ');
    throw new Error(
      `Provider envSecrets reference undeclared secret keys (add them to SECRETS_CONFIG): ${details}`,
    );
  }
}
