import { nullEmbeddingProvider } from './null';
import type { EmbeddingProvider } from './types';

export type { EmbeddingProvider } from './types';
export { nullEmbeddingProvider } from './null';
export { createOpenAIEmbeddingProvider } from './openai';

/**
 * Process-local registry of EmbeddingProvider instances, keyed by
 * `provider.name`. Populated at startup by the MemoryService bootstrap
 * (which knows how to construct providers that need credentials).
 *
 * The MemoryService reads from this registry per-namespace based on
 * the namespace's configured provider name. Tests can register fakes
 * via `registerEmbeddingProviderForTest` and rely on the teardown
 * function to restore prior state.
 */
const registry: Map<string, EmbeddingProvider> = new Map([
  [nullEmbeddingProvider.name, nullEmbeddingProvider],
]);

export function registerEmbeddingProvider(provider: EmbeddingProvider): void {
  registry.set(provider.name, provider);
}

export function getEmbeddingProvider(name: string): EmbeddingProvider | undefined {
  return registry.get(name);
}

export function listEmbeddingProviders(): readonly string[] {
  return Array.from(registry.keys());
}

/**
 * Test-only: register a provider and get a teardown function that
 * restores prior registry state. Used by unit tests to inject fakes
 * without leaking into other tests.
 */
export function registerEmbeddingProviderForTest(provider: EmbeddingProvider): () => void {
  const previous = registry.get(provider.name);
  registry.set(provider.name, provider);
  return () => {
    if (previous === undefined) {
      registry.delete(provider.name);
    } else {
      registry.set(provider.name, previous);
    }
  };
}
