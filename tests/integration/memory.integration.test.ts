/**
 * Standalone integration test for the memory subsystem.
 *
 * Exercises the full HTTP-endpoint stack against a real Express app,
 * a mock-but-fully-functional Redis (ioredis-mock), and the null-fake
 * embedding provider — i.e. everything except the real OpenAI API.
 * Demonstrates store/search/delete/prune end-to-end without involving
 * Winston or any specific agent.
 *
 * To run as a full real-service integration with OpenAI embeddings,
 * point the embedding provider at the real OpenAI factory and supply
 * `OPENAI_API_KEY`; the same test bodies validate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import RedisMock from 'ioredis-mock';
import type IORedis from 'ioredis';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createMemoryRoutes } from '../../src/routes/memory.routes';
import { MemoryService, setMemoryServiceForTest } from '../../src/services/memory/memory.service';
import {
  inMemoryVectorStore,
  registerVectorStoreForTest,
  type InMemoryVectorStore,
} from '../../src/services/memory/vector-store';
import { createRedisVectorStore } from '../../src/services/memory/vector-store/redis';
import type { NamespaceConfig } from '../../src/services/memory/memory.service';

const AGENT_TOKEN = 'integration-test-token';

const NAMESPACES: NamespaceConfig[] = [
  {
    name: 'integration-ns',
    embeddingProviderName: 'null-fake',
    vectorStoreName: 'redis',
    pruneAfterMs: 1_000,
    maxStoresPerRun: 100,
  },
];

describe('memory integration — HTTP endpoints + Redis vector store', () => {
  let redis: IORedis;
  let server: http.Server;
  let baseUrl: string;
  let teardownVectorStore: () => void;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as IORedis;
    process.env['CLAWNDOM_AGENT_TOKEN'] = AGENT_TOKEN;
    teardownVectorStore = registerVectorStoreForTest(createRedisVectorStore({ redis }));
    setMemoryServiceForTest(new MemoryService({ namespaces: NAMESPACES }));

    const app: Express = express();
    app.use(express.json());
    app.use('/api/memory', createMemoryRoutes());

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    setMemoryServiceForTest(null);
    teardownVectorStore();
    (inMemoryVectorStore as unknown as InMemoryVectorStore).clearForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await redis.flushall();
    await redis.quit();
  });

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{
    status: number;
    body: unknown;
  }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('store → search round-trip surfaces the entry as a top hit', async () => {
    const stored = await request('POST', '/api/memory/store', {
      namespace: 'integration-ns',
      text: 'Chris has a cat named Porter',
      traceId: 'trace-1',
    });
    expect(stored.status).toBe(200);
    const storedBody = stored.body as { id: string; namespace: string };
    expect(storedBody.namespace).toBe('integration-ns');
    expect(storedBody.id).toMatch(/^[0-9a-f-]+$/);

    const searched = await request('POST', '/api/memory/search', {
      namespace: 'integration-ns',
      query: 'Chris has a cat named Porter',
      topK: 3,
      minSimilarity: -1,
    });
    expect(searched.status).toBe(200);
    const searchBody = searched.body as { hits: Array<{ id: string; text: string }> };
    expect(searchBody.hits[0]?.id).toBe(storedBody.id);
    expect(searchBody.hits[0]?.text).toBe('Chris has a cat named Porter');
  });

  it('preserves and surfaces metadata across store/search', async () => {
    const stored = await request('POST', '/api/memory/store', {
      namespace: 'integration-ns',
      text: 'fact-1',
      metadata: { source: 'integration-test', tag: 'durable' },
      traceId: 't',
    });
    const storedBody = stored.body as { id: string };

    const searched = await request('POST', '/api/memory/search', {
      namespace: 'integration-ns',
      query: 'fact-1',
      minSimilarity: -1,
    });
    const hit = (searched.body as { hits: Array<{ id: string; metadata: unknown }> }).hits.find(
      (h) => h.id === storedBody.id,
    );
    expect(hit?.metadata).toEqual({ source: 'integration-test', tag: 'durable' });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const response = await fetch(`${baseUrl}/api/memory/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: 'integration-ns', text: 'x', traceId: 't' }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects invalid input with 400', async () => {
    const response = await request('POST', '/api/memory/store', {
      namespace: 'integration-ns',
      // text missing
      traceId: 't',
    });
    expect(response.status).toBe(400);
  });

  it('rejects unknown namespace with 400', async () => {
    const response = await request('POST', '/api/memory/store', {
      namespace: 'does-not-exist',
      text: 'x',
      traceId: 't',
    });
    expect(response.status).toBe(400);
  });

  it('delete removes the entry, subsequent search has no hit for that id', async () => {
    const stored = await request('POST', '/api/memory/store', {
      namespace: 'integration-ns',
      text: 'will-be-deleted',
      traceId: 't',
    });
    const storedId = (stored.body as { id: string }).id;

    const deleted = await request('DELETE', `/api/memory/${storedId}`, {
      namespace: 'integration-ns',
    });
    expect(deleted.status).toBe(200);
    expect((deleted.body as { deleted: boolean }).deleted).toBe(true);

    const searched = await request('POST', '/api/memory/search', {
      namespace: 'integration-ns',
      query: 'will-be-deleted',
      minSimilarity: -1,
    });
    const hits = (searched.body as { hits: Array<{ id: string }> }).hits;
    expect(hits.find((h) => h.id === storedId)).toBeUndefined();
  });

  it('full lifecycle: store, search bumps lastAccessedAt, prune preserves accessed', async () => {
    // Store an entry
    const stored = await request('POST', '/api/memory/store', {
      namespace: 'integration-ns',
      text: 'recently-accessed',
      traceId: 't',
    });
    const storedId = (stored.body as { id: string }).id;

    // Backdate it in Redis to simulate an old entry
    await redis.hset(
      `memory:integration-ns:${storedId}`,
      'lastAccessedAt',
      String(Date.now() - 10_000),
    );

    // Search bumps lastAccessedAt to now
    await request('POST', '/api/memory/search', {
      namespace: 'integration-ns',
      query: 'recently-accessed',
      minSimilarity: -1,
    });

    // Prune (the namespace's pruneAfter is 1s; without the bump this would
    // delete it, but we just bumped via search)
    const memoryService = (
      await import('../../src/services/memory/memory.service')
    ).getMemoryService();
    const pruneResult = await memoryService.prune({ namespace: 'integration-ns' });
    expect(pruneResult.deletedCount).toBe(0);
  });

  it('full lifecycle: stale entries are pruned', async () => {
    const stored = await request('POST', '/api/memory/store', {
      namespace: 'integration-ns',
      text: 'stale',
      traceId: 't',
    });
    const storedId = (stored.body as { id: string }).id;

    // Backdate beyond the namespace's pruneAfter (1s).
    await redis.hset(
      `memory:integration-ns:${storedId}`,
      'lastAccessedAt',
      String(Date.now() - 10_000),
    );

    const memoryService = (
      await import('../../src/services/memory/memory.service')
    ).getMemoryService();
    const pruneResult = await memoryService.prune({ namespace: 'integration-ns' });
    expect(pruneResult.deletedCount).toBe(1);

    const searched = await request('POST', '/api/memory/search', {
      namespace: 'integration-ns',
      query: 'stale',
      minSimilarity: -1,
    });
    expect((searched.body as { hits: unknown[] }).hits).toEqual([]);
  });
});
