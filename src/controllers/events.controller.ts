import type { Request, Response } from 'express';

import { getLogger } from '../lib/logging';
import { getEventBus } from '../services/event-bus.service';

const logger = getLogger('events-controller');

const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Server-Sent Events endpoint.
 *
 * Clients `GET /api/events` and receive every ClawndomEvent as a
 * text/event-stream message. A `: keepalive\n\n` comment every 15s keeps
 * proxies + browsers from closing the connection.
 *
 * Subscription is created before headers are flushed; unsubscription is
 * wired on `close`. Reconnection/backoff is the browser's / EventSource's
 * responsibility.
 */
export function handleEventStream(_request: Request, response: Response): void {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  const bus = getEventBus();
  const unsubscribe = bus.subscribe((event) => {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const keepalive = setInterval(() => {
    response.write(': keepalive\n\n');
  }, KEEPALIVE_INTERVAL_MS);

  const cleanup = (): void => {
    clearInterval(keepalive);
    unsubscribe();
  };

  response.on('close', () => {
    logger.debug({ listeners: bus.listenerCount() - 1 }, 'SSE client disconnected');
    cleanup();
  });
  response.on('error', cleanup);

  logger.debug({ listeners: bus.listenerCount() }, 'SSE client connected');
}
