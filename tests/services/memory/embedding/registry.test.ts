import { describe, expect, it } from 'vitest';

import {
  getEmbeddingProvider,
  listEmbeddingProviders,
  registerEmbeddingProviderForTest,
  type EmbeddingProvider,
} from '../../../../src/services/memory/embedding';

describe('embedding provider registry', () => {
  it('lists registered providers', () => {
    expect(listEmbeddingProviders()).toContain('null-fake');
  });

  it('resolves a registered provider by name', () => {
    expect(getEmbeddingProvider('null-fake')?.name).toBe('null-fake');
  });

  it('returns undefined for unknown names', () => {
    expect(getEmbeddingProvider('nope')).toBeUndefined();
  });

  it('test-only registration adds a fake and teardown restores prior state', () => {
    const fake: EmbeddingProvider = {
      name: 'test-only-fake',
      dimensions: 4,
      async embed() {
        return [0, 0, 0, 0];
      },
      async embedBatch(texts) {
        return texts.map(() => [0, 0, 0, 0]);
      },
    };
    expect(getEmbeddingProvider('test-only-fake')).toBeUndefined();
    const teardown = registerEmbeddingProviderForTest(fake);
    expect(getEmbeddingProvider('test-only-fake')).toBe(fake);
    teardown();
    expect(getEmbeddingProvider('test-only-fake')).toBeUndefined();
  });

  it('test-only registration overrides an existing provider and teardown restores it', () => {
    const original = getEmbeddingProvider('null-fake');
    const replacement: EmbeddingProvider = {
      name: 'null-fake',
      dimensions: 1,
      async embed() {
        return [1];
      },
      async embedBatch(texts) {
        return texts.map(() => [1]);
      },
    };
    const teardown = registerEmbeddingProviderForTest(replacement);
    expect(getEmbeddingProvider('null-fake')).toBe(replacement);
    teardown();
    expect(getEmbeddingProvider('null-fake')).toBe(original);
  });
});
