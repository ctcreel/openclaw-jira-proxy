import { describe, expect, it } from 'vitest';

import { nullEmbeddingProvider } from '../../../../src/services/memory/embedding/null';

describe('nullEmbeddingProvider', () => {
  it('exposes name and dimensions', () => {
    expect(nullEmbeddingProvider.name).toBe('null-fake');
    expect(nullEmbeddingProvider.dimensions).toBe(64);
  });

  it('embeds the same text to the same vector', async () => {
    const a = await nullEmbeddingProvider.embed('Chris has a cat named Porter');
    const b = await nullEmbeddingProvider.embed('Chris has a cat named Porter');
    expect(a).toEqual(b);
  });

  it('embeds different text to different vectors', async () => {
    const a = await nullEmbeddingProvider.embed('Chris has a cat named Porter');
    const b = await nullEmbeddingProvider.embed('Heather has a cat named Tabitha');
    expect(a).not.toEqual(b);
  });

  it('produces 64-dimensional vectors', async () => {
    const vector = await nullEmbeddingProvider.embed('hello');
    expect(vector).toHaveLength(64);
  });

  it('produces L2-normalized vectors', async () => {
    const vector = await nullEmbeddingProvider.embed('any text here');
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('embedBatch preserves order and matches single embed', async () => {
    const inputs = ['first', 'second', 'third'];
    const batch = await nullEmbeddingProvider.embedBatch(inputs);
    const single = await Promise.all(inputs.map((text) => nullEmbeddingProvider.embed(text)));
    expect(batch).toEqual(single);
  });

  it('embedBatch returns empty array for empty input', async () => {
    const result = await nullEmbeddingProvider.embedBatch([]);
    expect(result).toEqual([]);
  });
});
