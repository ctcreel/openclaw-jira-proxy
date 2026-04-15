import type { SecretProvider } from './types';

const providers: Record<string, SecretProvider> = {};

export function registerSecretProvider(provider: SecretProvider): void {
  providers[provider.name] = provider;
}

export function getSecretProvider(name: string): SecretProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(
      `Unknown secret provider: ${name}. Registered: ${Object.keys(providers).join(', ')}`,
    );
  }
  return provider;
}

export function getRegisteredSecretProviders(): readonly SecretProvider[] {
  return Object.values(providers);
}

export function resetSecretProviders(): void {
  for (const key of Object.keys(providers)) {
    delete providers[key];
  }
}
