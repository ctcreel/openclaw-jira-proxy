import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';

vi.mock('bullmq', () => {
  const Worker = vi.fn().mockImplementation((_name: string, processor: unknown) => {
    (globalThis as Record<string, unknown>).__capturedProcessor = processor;
    return { on: vi.fn() };
  });
  return { Worker };
});

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/config', () => ({
  getSettings: vi.fn(() => ({
    openclawHookUrl: 'http://127.0.0.1:18789/hooks/jira',
    openclawToken: 'test-openclaw-token',
    redisUrl: 'redis://127.0.0.1:6379',
  })),
}));

vi.mock('../../src/lib/logging', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

import { createWorker } from '../../src/services/worker.service';

type Processor = (job: { id: string; data: string }) => Promise<void>;

function getProcessor(): Processor {
  return (globalThis as Record<string, unknown>).__capturedProcessor as Processor;
}

describe('Worker integration', () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let receivedRequests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
    body: string;
  }>;

  beforeAll(async () => {
    receivedRequests = [];

    httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        receivedRequests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: {
            'content-type': request.headers['content-type'],
            authorization: request.headers['authorization'],
          },
          body: Buffer.concat(chunks).toString('utf-8'),
        });

        const runId = `run-${Date.now()}`;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, runId }));

        // Simulate agent completion after a short delay
        setTimeout(() => {
          for (const client of wss.clients) {
            client.send(JSON.stringify({ runId, status: 'done' }));
          }
        }, 50);
      });
    });

    wss = new WebSocketServer({ server: httpServer });

    await new Promise<void>((resolve) => {
      httpServer.listen(18789, '127.0.0.1', resolve);
    });

    createWorker();
  });

  afterEach(() => {
    receivedRequests = [];
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('should POST job data to OpenClaw, wait for WS completion, then resolve', async () => {
    const processor = getProcessor();
    const payload = '{"webhookEvent":"jira:issue_updated"}';

    await processor({ id: 'integration-job-1', data: payload });

    expect(receivedRequests).toHaveLength(1);
    const [request] = receivedRequests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/hooks/jira');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['authorization']).toBe('Bearer test-openclaw-token');
    expect(request.body).toBe(payload);
  });

  it('should process multiple jobs sequentially (second waits for first)', async () => {
    const processor = getProcessor();

    await processor({ id: 'seq-1', data: '{"event":"first"}' });
    await processor({ id: 'seq-2', data: '{"event":"second"}' });

    expect(receivedRequests).toHaveLength(2);
    expect(receivedRequests[0].body).toBe('{"event":"first"}');
    expect(receivedRequests[1].body).toBe('{"event":"second"}');
  });
});
