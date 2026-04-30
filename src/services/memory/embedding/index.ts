import { nullEmbeddingProvider } from './null';
import type { EmbeddingProvider } from './types';

export type { EmbeddingProvider } from './types';
export { nullEmbeddingProvider } from './null';
export { createOpenAIEmbeddingProvider } from './openai';

/**
 * The set of all provider NAMES Clawndom recognizes. Validation at
 * config-load time checks against this list (so a YAML referencing
 * `embeddingProvider: openai` doesn't fail validation just because
 * the OpenAI instance hasn't been bootstrapped yet — the bootstrap
 * may resolve the API key after validation runs).
 *
 * Adding a new provider type means adding the name here AND
 * registering an instance via `registerEmbeddingProvider` (typically
 * in the memory bootstrap).
 */
const KNOWN_PROVIDER_NAMES: readonly string[] = ['null-fake', 'openai'];

/**
 * Process-local registry of EmbeddingProvider INSTANCES, keyed by
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

/**
 * All provider names Clawndom recognizes — used by config validation,
 * NOT runtime resolution. Returns a superset of currently-instantiated
 * providers (an unbootstrapped provider is still a known name).
 */
export function listEmbeddingProviders(): readonly string[] {
  return KNOWN_PROVIDER_NAMES;
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
