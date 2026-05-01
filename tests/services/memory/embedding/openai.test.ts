import { describe, expect, it, vi } from 'vitest';

import { createOpenAIEmbeddingProvider } from '../../../../src/services/memory/embedding/openai';

describe('OpenAIEmbeddingProvider', () => {
  it('has name "openai" and 1536 dimensions', () => {
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'test', fetchImpl: vi.fn() });
    expect(provider.name).toBe('openai');
    expect(provider.dimensions).toBe(1536);
  });

  it('sends a POST to the embeddings endpoint with correct headers and body', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }), {
          status: 200,
        }),
    );
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'sk-test', fetchImpl: fetchMock });

    await provider.embed('hello');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toEqual(['hello']);
  });

  it('returns the vector from the API response', async () => {
    const expected = new Array(1536).fill(0).map((_, i) => i / 1536);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: expected }] }), { status: 200 }),
    );
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'k', fetchImpl: fetchMock });

    const result = await provider.embed('hi');
    expect(result).toEqual(expected);
  });

  it('embedBatch sends all inputs in one request and preserves order', async () => {
    const inputs = ['first', 'second', 'third'];
    const expected = inputs.map((_, i) => new Array(1536).fill(i + 1));
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: expected.map((embedding) => ({ embedding })) }), {
          status: 200,
        }),
    );
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'k', fetchImpl: fetchMock });

    const result = await provider.embedBatch(inputs);

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.input).toEqual(inputs);
    expect(result).toEqual(expected);
  });

  it('embedBatch returns empty array without hitting the API for empty input', async () => {
    const fetchMock = vi.fn();
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'k', fetchImpl: fetchMock });

    const result = await provider.embedBatch([]);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on non-2xx response with the API error message', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
    );
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'bad', fetchImpl: fetchMock });

    await expect(provider.embed('hi')).rejects.toThrow(/Invalid API key/);
  });

  it('throws when response data length does not match input length', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0) }] }), {
          status: 200,
        }),
    );
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'k', fetchImpl: fetchMock });

    await expect(provider.embedBatch(['a', 'b', 'c'])).rejects.toThrow(/1 vectors for 3 inputs/);
  });

  it('embed throws when the batch returns no vectors at all', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const provider = createOpenAIEmbeddingProvider({ apiKey: 'k', fetchImpl: fetchMock });

    await expect(provider.embed('hello')).rejects.toThrow(
      /returned no vector for a single input|0 vectors for 1 inputs/,
    );
  });
});
