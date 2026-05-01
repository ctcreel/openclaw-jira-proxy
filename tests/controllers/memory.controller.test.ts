import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  postMemoryStore,
  postMemorySearch,
  deleteMemoryEntry,
} from '../../src/controllers/memory.controller';
import {
  setMemoryServiceForTest,
  ProviderNotRegisteredError,
  RateLimitExceededError,
  UnknownNamespaceError,
  type MemoryService,
} from '../../src/services/memory/memory.service';

const VALID_TOKEN = 'test-bearer-token';

function mountApp(): Express {
  const app = express();
  app.use(express.json());
  app.post('/api/memory/store', postMemoryStore);
  app.post('/api/memory/search', postMemorySearch);
  app.delete('/api/memory/:id', deleteMemoryEntry);
  return app;
}

function makeFakeService(overrides: Partial<MemoryService>): MemoryService {
  const noop = (): never => {
    throw new Error('not stubbed in this test');
  };
  return {
    store: overrides.store ?? noop,
    search: overrides.search ?? noop,
    delete: overrides.delete ?? noop,
    prune: overrides.prune ?? noop,
  } as unknown as MemoryService;
}

describe('memory controller', () => {
  let server: Server;
  let baseUrl: string;
  let originalToken: string | undefined;

  beforeEach(async () => {
    originalToken = process.env['CLAWNDOM_AGENT_TOKEN'];
    process.env['CLAWNDOM_AGENT_TOKEN'] = VALID_TOKEN;
    setMemoryServiceForTest(null);
    const app = mountApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    setMemoryServiceForTest(null);
    if (originalToken === undefined) {
      delete process.env['CLAWNDOM_AGENT_TOKEN'];
    } else {
      process.env['CLAWNDOM_AGENT_TOKEN'] = originalToken;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('auth', () => {
    it('rejects requests with no Authorization header (401)', async () => {
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: 'n', text: 't', traceId: 'x' }),
      });
      expect(response.status).toBe(401);
    });

    it('rejects requests with a non-Bearer Authorization header (401)', async () => {
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic abcdef',
        },
        body: JSON.stringify({ namespace: 'n', text: 't', traceId: 'x' }),
      });
      expect(response.status).toBe(401);
    });

    it('rejects requests with a wrong Bearer token (401)', async () => {
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong',
        },
        body: JSON.stringify({ namespace: 'n', text: 't', traceId: 'x' }),
      });
      expect(response.status).toBe(401);
    });

    it('rejects all requests when CLAWNDOM_AGENT_TOKEN is unset (401)', async () => {
      delete process.env['CLAWNDOM_AGENT_TOKEN'];
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'n', text: 't', traceId: 'x' }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/memory/store', () => {
    it('returns 200 with the service result on a valid request', async () => {
      const store = vi.fn().mockResolvedValue({ id: 'mem_1', stored: true });
      setMemoryServiceForTest(makeFakeService({ store }));
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({
          namespace: 'winston-personal',
          text: "Chris's dog Charlie has passed away",
          metadata: { source: 'slack-dm' },
          traceId: 'trace-123',
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ id: 'mem_1', stored: true });
      expect(store).toHaveBeenCalledOnce();
    });

    it('returns 400 when the body fails Zod validation (missing namespace)', async () => {
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ text: 't', traceId: 'x' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid request');
      expect(body.details).toBeDefined();
    });

    it('maps UnknownNamespaceError → 400', async () => {
      const store = vi.fn().mockRejectedValue(new UnknownNamespaceError('no-such'));
      setMemoryServiceForTest(makeFakeService({ store }));
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'no-such', text: 't', traceId: 'x' }),
      });
      expect(response.status).toBe(400);
    });

    it('maps RateLimitExceededError → 429', async () => {
      const store = vi.fn().mockRejectedValue(new RateLimitExceededError('limit hit'));
      setMemoryServiceForTest(makeFakeService({ store }));
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'n', text: 't', traceId: 'x' }),
      });
      expect(response.status).toBe(429);
    });

    it('maps ProviderNotRegisteredError → 500', async () => {
      const store = vi.fn().mockRejectedValue(new ProviderNotRegisteredError('embedding'));
      setMemoryServiceForTest(makeFakeService({ store }));
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'n', text: 't', traceId: 'x' }),
      });
      expect(response.status).toBe(500);
    });

    it('maps unknown errors → 500 with a generic message', async () => {
      const store = vi.fn().mockRejectedValue(new Error('boom'));
      setMemoryServiceForTest(makeFakeService({ store }));
      const response = await fetch(`${baseUrl}/api/memory/store`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'n', text: 't', traceId: 'x' }),
      });
      expect(response.status).toBe(500);
    });
  });

  describe('POST /api/memory/search', () => {
    it('returns 200 with hits on a valid request', async () => {
      const search = vi.fn().mockResolvedValue({
        hits: [{ id: 'mem_1', text: "Charlie was Chris's dog", score: 0.91 }],
      });
      setMemoryServiceForTest(makeFakeService({ search }));
      const response = await fetch(`${baseUrl}/api/memory/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({
          namespace: 'winston-personal',
          query: "what was Chris's dog's name?",
          topK: 5,
          minSimilarity: 0.4,
          traceId: 'trace-123',
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.hits).toHaveLength(1);
    });

    it('returns 400 when query is empty', async () => {
      const response = await fetch(`${baseUrl}/api/memory/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'n', query: '' }),
      });
      expect(response.status).toBe(400);
    });

    it('returns 400 when topK exceeds 50', async () => {
      const response = await fetch(`${baseUrl}/api/memory/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'n', query: 'q', topK: 51 }),
      });
      expect(response.status).toBe(400);
    });

    it('maps service errors via statusFor (UnknownNamespaceError → 400)', async () => {
      const search = vi.fn().mockRejectedValue(new UnknownNamespaceError('no-such'));
      setMemoryServiceForTest(makeFakeService({ search }));
      const response = await fetch(`${baseUrl}/api/memory/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'no-such', query: 'q' }),
      });
      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/memory/:id', () => {
    it('returns 200 on a valid delete', async () => {
      const del = vi.fn().mockResolvedValue({ deleted: true });
      setMemoryServiceForTest(makeFakeService({ delete: del }));
      const response = await fetch(`${baseUrl}/api/memory/mem_1`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'winston-personal' }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ deleted: true });
      expect(del).toHaveBeenCalledWith({ namespace: 'winston-personal', id: 'mem_1' });
    });

    it('returns 400 when the body fails validation (missing namespace)', async () => {
      const response = await fetch(`${baseUrl}/api/memory/mem_1`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    it('maps service errors → 500 for unknown error types', async () => {
      const del = vi.fn().mockRejectedValue(new Error('redis disconnected'));
      setMemoryServiceForTest(makeFakeService({ delete: del }));
      const response = await fetch(`${baseUrl}/api/memory/mem_1`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({ namespace: 'n' }),
      });
      expect(response.status).toBe(500);
    });
  });
});
