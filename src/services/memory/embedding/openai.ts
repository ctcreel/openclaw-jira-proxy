import type { EmbeddingProvider } from './types';

/**
 * OpenAI `text-embedding-3-small` provider. 1536-dimension output,
 * ~$0.02 per 1M input tokens, ~50ms latency. The cheapest production
 * embedding option that's accurate enough for cross-conversation
 * memory recall.
 *
 * Authentication is per-call via `apiKey` injected at construction —
 * the constructor reads it from the SecretManager-resolved value the
 * MemoryService passes in. This module makes no assumptions about
 * credential storage (matches `agency_tools.slack` convention).
 */
const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const MODEL_ID = 'text-embedding-3-small';
const DIMENSIONS = 1536;

interface OpenAIEmbeddingResponse {
  data?: Array<{ embedding: number[] }>;
  error?: { message: string };
}

export interface OpenAIEmbeddingProviderOptions {
  readonly apiKey: string;
  /** Override for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = DIMENSIONS;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    if (vector === undefined) {
      throw new Error('OpenAI embeddings API returned no vector for a single input');
    }
    return vector;
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL_ID, input: [...texts] }),
    });
    const body = (await response.json()) as OpenAIEmbeddingResponse;
    if (!response.ok) {
      const message = body.error?.message ?? `OpenAI embeddings API ${response.status}`;
      throw new Error(`OpenAI embeddings request failed: ${message}`);
    }
    const data = body.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(
        `OpenAI embeddings API returned ${data?.length ?? 0} vectors for ${texts.length} inputs`,
      );
    }
    return data.map((entry) => entry.embedding);
  }
}

/**
 * Factory used by the registry. The MemoryService passes in the resolved
 * API key when it constructs per-namespace embedding clients, so this
 * factory stays pure — no globals, no env-var reads.
 */
export function createOpenAIEmbeddingProvider(
  options: OpenAIEmbeddingProviderOptions,
): EmbeddingProvider {
  return new OpenAIEmbeddingProvider(options);
}
