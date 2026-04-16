import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { handleEventStream } from '../../src/controllers/events.controller';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import type { ClawndomEvent } from '../../src/types/clawndom-event';

function mountApp(): Express {
  const app = express();
  app.get('/api/events', handleEventStream);
  return app;
}

describe('SSE /api/events', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    resetEventBus();
    const app = mountApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('streams published events as text/event-stream frames', async () => {
    const controller = new AbortController();
    const received: string[] = [];

    const readPromise = fetch(`${baseUrl}/api/events`, { signal: controller.signal }).then(
      async (response) => {
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        while (received.join('').split('\n\n').length <= 2) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received.push(decoder.decode(chunk.value));
        }
      },
    );

    // Wait for the subscription to register, then publish.
    await waitForListener();

    const event: ClawndomEvent = {
      type: 'job.started',
      timestamp: 42,
      traceId: 'trace-1',
      jobId: 'job-1',
      provider: 'jira',
      agentId: 'patch',
      runner: 'claude-cli',
    };
    getEventBus().publish(event);

    await waitUntil(() => received.join('').includes('"job.started"'));
    controller.abort();
    await readPromise.catch(() => {});

    const joined = received.join('');
    expect(joined).toContain('event: job.started');
    expect(joined).toContain('"jobId":"job-1"');
  });
});

async function waitForListener(): Promise<void> {
  await waitUntil(() => getEventBus().listenerCount() > 0);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
