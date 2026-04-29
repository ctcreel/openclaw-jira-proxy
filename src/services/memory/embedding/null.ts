import { createHash } from 'node:crypto';

import type { EmbeddingProvider } from './types';

/**
 * Test-only EmbeddingProvider. Produces a deterministic vector from the
 * SHA-256 hash of the input text — same input always yields the same
 * vector, different inputs yield different vectors. No network, no API
 * key required.
 *
 * The 64-dimension vector is small enough to keep test fixtures tiny
 * and large enough to give nontrivial cosine-similarity behavior across
 * a handful of test inputs. Production providers (OpenAI: 1536) yield
 * different dimensions; namespaces are pinned to one provider.
 */
const NULL_DIMENSIONS = 64;

class NullEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'null-fake';
  readonly dimensions = NULL_DIMENSIONS;

  async embed(text: string): Promise<number[]> {
    return hashToVector(text, NULL_DIMENSIONS);
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => hashToVector(text, NULL_DIMENSIONS));
  }
}

/**
 * Hash text to a fixed-dimension unit vector. SHA-256 yields 32 bytes;
 * we expand to `dimensions` floats by repeating the digest and mapping
 * each byte to a [-1, 1) float, then L2-normalize so cosine similarity
 * is well-defined on the result.
 */
function hashToVector(text: string, dimensions: number): number[] {
  const digest = createHash('sha256').update(text).digest();
  const result: number[] = new Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const byteAt = digest[index % digest.length];
    if (byteAt === undefined) {
      throw new Error('unreachable: digest length is fixed at 32');
    }
    result[index] = byteAt / 127.5 - 1;
  }
  let sumOfSquares = 0;
  for (const value of result) {
    sumOfSquares += value * value;
  }
  const magnitude = Math.sqrt(sumOfSquares);
  if (magnitude === 0) {
    return result;
  }
  for (let index = 0; index < dimensions; index += 1) {
    const current = result[index];
    if (current !== undefined) {
      result[index] = current / magnitude;
    }
  }
  return result;
}

export const nullEmbeddingProvider: EmbeddingProvider = new NullEmbeddingProvider();
