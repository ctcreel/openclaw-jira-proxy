import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleEventStream } from '../../src/controllers/events.controller';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import type { ClawndomEvent } from '../../src/types/clawndom-event';

function mountApp(): Express {
  const app = express();
  app.get('/api/events', handleEventStream);
  return app;
}

const startedEvent: ClawndomEvent = {
  type: 'job.started',
  timestamp: 42,
  traceId: 'trace-1',
  jobId: 'job-1',
  provider: 'jira',
  agentId: 'patch',
  runner: 'claude-cli',
};

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

  it('streams published events as text/event-stream frames with id lines', async () => {
    const sse = openSse(`${baseUrl}/api/events`, {
      onResponse: (response) => {
        expect(response.headers.get('content-type')).toContain('text/event-stream');
      },
    });

    await waitForListener();
    getEventBus().publish(startedEvent);

    await waitUntil(() => sse.joined().includes('"job.started"'));
    await sse.finish();

    const joined = sse.joined();
    expect(joined).toContain('id: 1');
    expect(joined).toContain('event: job.started');
    expect(joined).toContain('"jobId":"job-1"');
  });

  it('replays buffered events with id > Last-Event-ID before going live', async () => {
    // Publish two events BEFORE any client connects — these would be lost
    // under the pre-SPE-1976 behavior.
    getEventBus().publish(startedEvent);
    getEventBus().publish({ ...startedEvent, jobId: 'job-2' });

    const sse = openSse(`${baseUrl}/api/events`, {
      headers: { 'Last-Event-ID': '1' },
    });

    await waitUntil(() => sse.joined().includes('"jobId":"job-2"'), 3000);
    await sse.finish();

    const joined = sse.joined();
    expect(joined).toContain('"jobId":"job-2"');
    expect(joined).toContain('id: 2');
    // Event id=1 should NOT be replayed because Last-Event-ID asked for >1.
    expect(joined).not.toContain('"jobId":"job-1"');
  });

  it('falls back to ?since= query when Last-Event-ID header is absent', async () => {
    getEventBus().publish(startedEvent);
    getEventBus().publish({ ...startedEvent, jobId: 'job-2' });

    const sse = openSse(`${baseUrl}/api/events?since=1`);

    await waitUntil(() => sse.joined().includes('"jobId":"job-2"'), 3000);
    await sse.finish();

    const joined = sse.joined();
    expect(joined).toContain('"jobId":"job-2"');
    expect(joined).not.toContain('"jobId":"job-1"');
  });

  it('header takes precedence over ?since= when both are present', async () => {
    getEventBus().publish(startedEvent);
    getEventBus().publish({ ...startedEvent, jobId: 'job-2' });
    getEventBus().publish({ ...startedEvent, jobId: 'job-3' });

    const sse = openSse(`${baseUrl}/api/events?since=1`, {
      headers: { 'Last-Event-ID': '2' },
    });

    await waitUntil(() => sse.joined().includes('"jobId":"job-3"'), 3000);
    await sse.finish();

    const joined = sse.joined();
    // Header said "since=2", so only id=3 should appear, not id=2.
    expect(joined).toContain('"jobId":"job-3"');
    expect(joined).not.toContain('"jobId":"job-2"');
  });

  it('emits a gap event when Last-Event-ID is older than the buffer head', async () => {
    process.env['EVENT_REPLAY_BUFFER_SIZE'] = '2';
    resetEventBus();
    try {
      const bus = getEventBus();
      bus.publish(startedEvent); // id=1
      bus.publish(startedEvent); // id=2
      bus.publish(startedEvent); // id=3 — pushes id=1 out
      bus.publish(startedEvent); // id=4 — pushes id=2 out, buffer now [3,4]

      const sse = openSse(`${baseUrl}/api/events`, {
        headers: { 'Last-Event-ID': '1' },
      });

      await waitUntil(() => sse.joined().includes('event: gap'), 3000);
      await sse.finish();

      const joined = sse.joined();
      expect(joined).toContain('event: gap');
      expect(joined).toContain('"reason":"buffer-overflow"');
    } finally {
      delete process.env['EVENT_REPLAY_BUFFER_SIZE'];
      resetEventBus();
    }
  });

  it('regression: an event published while replay frames are being written is delivered exactly once (SPE-1976)', async () => {
    // This pins the no-duplicate / no-miss invariant across the replay-then-attach
    // boundary. See EventBus.subscribeSince — the contract is that the just-attached
    // subscriber gets every publish strictly after attach, never an event from the
    // replay slice.
    getEventBus().publish(startedEvent);

    const sse = openSse(`${baseUrl}/api/events`);

    await waitForListener();
    // Concurrent live publish — subscribeSince attached the handler synchronously
    // before this publish, so it must be delivered exactly once with id=2.
    getEventBus().publish({ ...startedEvent, jobId: 'job-2' });

    await waitUntil(() => sse.joined().includes('"jobId":"job-2"'), 3000);
    await sse.finish();

    const joined = sse.joined();
    const matches = joined.match(/"jobId":"job-2"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(joined).toContain('id: 2');
  });
});

interface SseHarness {
  joined(): string;
  finish(): Promise<void>;
}

interface OpenSseOptions {
  headers?: Record<string, string>;
  onResponse?: (response: Response) => void;
}

// Connects to an SSE endpoint and accumulates frames until finish() is called.
// Centralizes the AbortController + reader-loop scaffolding so individual tests
// only express what's specific to them (URL, headers, assertions).
function openSse(url: string, options: OpenSseOptions = {}): SseHarness {
  const controller = new AbortController();
  const received: string[] = [];

  const readPromise = fetch(url, {
    signal: controller.signal,
    ...(options.headers ? { headers: options.headers } : {}),
  }).then(async (response) => {
    options.onResponse?.(response);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    // Read until the test calls finish() — the AbortController interrupts
    // the in-flight read() and the loop breaks.
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received.push(decoder.decode(chunk.value));
    }
  });

  return {
    joined: () => received.join(''),
    finish: async (): Promise<void> => {
      controller.abort();
      await readPromise.catch(() => {});
    },
  };
}

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
