import type IORedis from 'ioredis';

import { getLogger } from '../../../lib/logging';

import type { MemoryEntry, PruneOptions, SearchHit, SearchOptions, VectorStore } from './types';

const logger = getLogger('memory:redis-store');

/**
 * Redis-backed VectorStore using only vanilla Redis primitives — no
 * RediSearch / Stack module required. Entries are stored as hashes:
 *
 *   key: `memory:<namespace>:<id>`
 *   fields:
 *     namespace        string
 *     text             string
 *     metadata         JSON-encoded string
 *     vector           binary blob (Float32Array little-endian)
 *     dimensions       integer (sanity check)
 *     createdAt        integer (epoch ms)
 *     lastAccessedAt   integer (epoch ms)
 *
 * A per-namespace index set tracks all ids:
 *
 *   key: `memory-index:<namespace>` — Redis SET of entry ids
 *
 * Search is a brute-force linear scan: SMEMBERS the index, MGET the
 * hashes, compute cosine similarity in Node, sort, top-K. Fine for the
 * thousands-of-entries scale we expect; if it ever stops being fine,
 * swap in a RediSearch-backed implementation under the same interface.
 *
 * Why brute-force over RediSearch as the v1: RediSearch needs the
 * redis-stack image, which not every Redis deployment runs. Vanilla
 * Redis is the lowest-common-denominator. Performance can be revisited
 * via the Strategy pattern later.
 */
const NS_DIM_KEY_PREFIX = 'memory-meta:';

export interface RedisVectorStoreOptions {
  readonly redis: IORedis;
}

class RedisVectorStore implements VectorStore {
  readonly name = 'redis';

  private readonly redis: IORedis;
  /** Cached per-namespace dimension. Populated lazily from redis. */
  private readonly dimensionsCache: Map<string, number> = new Map();

  constructor(options: RedisVectorStoreOptions) {
    this.redis = options.redis;
  }

  async upsert(entry: MemoryEntry): Promise<void> {
    const expectedDimension = await this.getDimension(entry.namespace);
    if (expectedDimension !== null && expectedDimension !== entry.vector.length) {
      throw new Error(
        `Namespace '${entry.namespace}' is pinned to ${expectedDimension} dimensions; got ${entry.vector.length}`,
      );
    }
    if (expectedDimension === null) {
      await this.setDimension(entry.namespace, entry.vector.length);
    }

    const entryKey = buildEntryKey(entry.namespace, entry.id);
    const indexKey = buildIndexKey(entry.namespace);
    const buffer = Buffer.from(Float32Array.from(entry.vector).buffer);

    const pipeline = this.redis.pipeline();
    pipeline.hset(entryKey, {
      namespace: entry.namespace,
      text: entry.text,
      metadata: JSON.stringify(entry.metadata),
      vector: buffer,
      dimensions: String(entry.vector.length),
      createdAt: String(entry.createdAt),
      lastAccessedAt: String(entry.lastAccessedAt),
    });
    pipeline.sadd(indexKey, entry.id);
    await pipeline.exec();
  }

  async search(opts: SearchOptions): Promise<readonly SearchHit[]> {
    const { namespace, queryVector, topK, minSimilarity } = opts;
    const ids = await this.redis.smembers(buildIndexKey(namespace));
    if (ids.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      // Read the binary vector + the fields we need to surface in hits.
      // ioredis .hgetallBuffer is the Buffer-aware variant of HGETALL.
      pipeline.hgetallBuffer(buildEntryKey(namespace, id));
    }
    const results = await pipeline.exec();
    if (results === null) return [];

    const candidates: Array<{
      id: string;
      score: number;
      text: string;
      metadata: Record<string, unknown>;
    }> = [];
    for (let index = 0; index < ids.length; index += 1) {
      const slot = results[index];
      if (slot === undefined) continue;
      const [error, raw] = slot;
      if (error !== null) {
        logger.warn(
          { namespace, id: ids[index], error: error.message },
          'Redis HGETALLBUFFER failed during search; skipping entry',
        );
        continue;
      }
      const fields = raw as Record<string, Buffer> | null;
      if (fields === null || Object.keys(fields).length === 0) continue;
      const vectorBuffer = fields['vector'];
      const text = fields['text']?.toString('utf-8');
      const metadataRaw = fields['metadata']?.toString('utf-8');
      if (vectorBuffer === undefined || text === undefined) continue;

      const stored = bufferToFloat32Array(vectorBuffer);
      if (stored.length !== queryVector.length) continue;
      const score = cosineSimilarity(stored, queryVector);
      if (score < minSimilarity) continue;

      const idValue = ids[index];
      if (idValue === undefined) continue;
      candidates.push({
        id: idValue,
        score,
        text,
        metadata:
          metadataRaw === undefined ? {} : (JSON.parse(metadataRaw) as Record<string, unknown>),
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, topK);

    if (top.length > 0) {
      const now = Date.now();
      const touchPipeline = this.redis.pipeline();
      for (const hit of top) {
        touchPipeline.hset(buildEntryKey(namespace, hit.id), 'lastAccessedAt', String(now));
      }
      await touchPipeline.exec();
    }

    return top.map((hit) => ({
      id: hit.id,
      namespace,
      text: hit.text,
      metadata: hit.metadata,
      score: hit.score,
    }));
  }

  async touchAccess(id: string, namespace: string): Promise<void> {
    const exists = await this.redis.exists(buildEntryKey(namespace, id));
    if (exists === 0) return;
    await this.redis.hset(buildEntryKey(namespace, id), 'lastAccessedAt', String(Date.now()));
  }

  async prune(opts: PruneOptions): Promise<number> {
    const ids = await this.redis.smembers(buildIndexKey(opts.namespace));
    if (ids.length === 0) return 0;

    const tsPipeline = this.redis.pipeline();
    for (const id of ids) {
      tsPipeline.hget(buildEntryKey(opts.namespace, id), 'lastAccessedAt');
    }
    const tsResults = await tsPipeline.exec();
    if (tsResults === null) return 0;

    const toDelete: string[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      const slot = tsResults[index];
      if (slot === undefined) continue;
      const [error, raw] = slot;
      if (error !== null) continue;
      const ts = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
      if (Number.isNaN(ts)) continue;
      if (ts < opts.olderThanMs) {
        const idValue = ids[index];
        if (idValue !== undefined) toDelete.push(idValue);
      }
    }
    if (toDelete.length === 0) return 0;

    const deletePipeline = this.redis.pipeline();
    for (const id of toDelete) {
      deletePipeline.del(buildEntryKey(opts.namespace, id));
      deletePipeline.srem(buildIndexKey(opts.namespace), id);
    }
    await deletePipeline.exec();
    return toDelete.length;
  }

  async count(namespace: string): Promise<number> {
    return this.redis.scard(buildIndexKey(namespace));
  }

  async delete(id: string, namespace: string): Promise<boolean> {
    const removed = await this.redis.srem(buildIndexKey(namespace), id);
    if (removed === 0) return false;
    await this.redis.del(buildEntryKey(namespace, id));
    return true;
  }

  private async getDimension(namespace: string): Promise<number | null> {
    const cached = this.dimensionsCache.get(namespace);
    if (cached !== undefined) return cached;
    const raw = await this.redis.get(`${NS_DIM_KEY_PREFIX}${namespace}`);
    if (raw === null) return null;
    const dimension = Number.parseInt(raw, 10);
    if (!Number.isInteger(dimension) || dimension <= 0) return null;
    this.dimensionsCache.set(namespace, dimension);
    return dimension;
  }

  private async setDimension(namespace: string, dimension: number): Promise<void> {
    this.dimensionsCache.set(namespace, dimension);
    await this.redis.set(`${NS_DIM_KEY_PREFIX}${namespace}`, String(dimension));
  }
}

function buildEntryKey(namespace: string, id: string): string {
  return `memory:${namespace}:${id}`;
}

function buildIndexKey(namespace: string): string {
  return `memory-index:${namespace}`;
}

function bufferToFloat32Array(buffer: Buffer): Float32Array {
  const floats = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return floats;
}

function cosineSimilarity(a: Float32Array, b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let index = 0; index < a.length; index += 1) {
    const aValue = a[index];
    const bValue = b[index];
    if (aValue === undefined || bValue === undefined) return 0;
    dot += aValue * bValue;
    aMag += aValue * aValue;
    bMag += bValue * bValue;
  }
  const magnitude = Math.sqrt(aMag) * Math.sqrt(bMag);
  if (magnitude === 0) return 0;
  return dot / magnitude;
}

export function createRedisVectorStore(options: RedisVectorStoreOptions): VectorStore {
  return new RedisVectorStore(options);
}
