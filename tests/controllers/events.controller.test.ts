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

    await waitForListener();
    getEventBus().publish(startedEvent);

    await waitUntil(() => received.join('').includes('"job.started"'));
    controller.abort();
    await readPromise.catch(() => {});

    const joined = received.join('');
    expect(joined).toContain('id: 1');
    expect(joined).toContain('event: job.started');
    expect(joined).toContain('"jobId":"job-1"');
  });

  it('replays buffered events with id > Last-Event-ID before going live', async () => {
    // Publish two events BEFORE any client connects — these would be lost
    // under the pre-SPE-1976 behavior.
    getEventBus().publish(startedEvent);
    getEventBus().publish({ ...startedEvent, jobId: 'job-2' });

    const controller = new AbortController();
    const received: string[] = [];

    const readPromise = fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
      headers: { 'Last-Event-ID': '1' },
    }).then(async (response) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      while (received.join('').split('\n\n').length <= 2) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received.push(decoder.decode(chunk.value));
      }
    });

    await waitUntil(() => received.join('').includes('"jobId":"job-2"'), 3000);
    controller.abort();
    await readPromise.catch(() => {});

    const joined = received.join('');
    expect(joined).toContain('"jobId":"job-2"');
    expect(joined).toContain('id: 2');
    // Event id=1 should NOT be replayed because Last-Event-ID asked for >1.
    expect(joined).not.toContain('"jobId":"job-1"');
  });

  it('falls back to ?since= query when Last-Event-ID header is absent', async () => {
    getEventBus().publish(startedEvent);
    getEventBus().publish({ ...startedEvent, jobId: 'job-2' });

    const controller = new AbortController();
    const received: string[] = [];

    const readPromise = fetch(`${baseUrl}/api/events?since=1`, { signal: controller.signal }).then(
      async (response) => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        while (received.join('').split('\n\n').length <= 2) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received.push(decoder.decode(chunk.value));
        }
      },
    );

    await waitUntil(() => received.join('').includes('"jobId":"job-2"'), 3000);
    controller.abort();
    await readPromise.catch(() => {});

    const joined = received.join('');
    expect(joined).toContain('"jobId":"job-2"');
    expect(joined).not.toContain('"jobId":"job-1"');
  });

  it('header takes precedence over ?since= when both are present', async () => {
    getEventBus().publish(startedEvent);
    getEventBus().publish({ ...startedEvent, jobId: 'job-2' });
    getEventBus().publish({ ...startedEvent, jobId: 'job-3' });

    const controller = new AbortController();
    const received: string[] = [];

    const readPromise = fetch(`${baseUrl}/api/events?since=1`, {
      signal: controller.signal,
      headers: { 'Last-Event-ID': '2' },
    }).then(async (response) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      while (received.join('').split('\n\n').length <= 2) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received.push(decoder.decode(chunk.value));
      }
    });

    await waitUntil(() => received.join('').includes('"jobId":"job-3"'), 3000);
    controller.abort();
    await readPromise.catch(() => {});

    const joined = received.join('');
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

      const controller = new AbortController();
      const received: string[] = [];

      const readPromise = fetch(`${baseUrl}/api/events`, {
        signal: controller.signal,
        headers: { 'Last-Event-ID': '1' },
      }).then(async (response) => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        while (received.join('').split('\n\n').length <= 3) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received.push(decoder.decode(chunk.value));
        }
      });

      await waitUntil(() => received.join('').includes('event: gap'), 3000);
      controller.abort();
      await readPromise.catch(() => {});

      const joined = received.join('');
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

    const controller = new AbortController();
    const received: string[] = [];

    const readPromise = fetch(`${baseUrl}/api/events`, { signal: controller.signal }).then(
      async (response) => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        while (received.join('').split('\n\n').length <= 3) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received.push(decoder.decode(chunk.value));
        }
      },
    );

    await waitForListener();
    // Concurrent live publish — subscribeSince attached the handler synchronously
    // before this publish, so it must be delivered exactly once with id=2.
    getEventBus().publish({ ...startedEvent, jobId: 'job-2' });

    await waitUntil(() => received.join('').includes('"jobId":"job-2"'), 3000);
    controller.abort();
    await readPromise.catch(() => {});

    const joined = received.join('');
    const matches = joined.match(/"jobId":"job-2"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(joined).toContain('id: 2');
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
