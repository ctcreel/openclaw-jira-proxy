import type { Request, Response } from 'express';

import { getLogger } from '../lib/logging';
import { getEventBus } from '../services/event-bus.service';
import type { StampedEvent } from '../services/event-bus.service';

const logger = getLogger('events-controller');

const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Server-Sent Events endpoint.
 *
 * Clients `GET /api/events` and receive every ClawndomEvent as a
 * text/event-stream message. Each frame carries an `id:` line so the
 * browser/EventSource auto-tracks position. On reconnect, clients send
 * `Last-Event-ID` (header) or `?since=<id>` (query fallback for clients that
 * can't easily set headers); the server replays buffered events strictly
 * after that id before going live. A `: keepalive\n\n` comment every 15s
 * keeps proxies + browsers from closing the connection.
 *
 * Replay and live attachment happen in one synchronous block via
 * `EventBus.subscribeSince` so no event published mid-attach is lost.
 *
 * If the requested `Last-Event-ID` is older than the buffer can replay, the
 * server emits a single `event: gap` frame so the client can re-bootstrap
 * from `/api/queue/snapshot` instead of treating the partial replay as
 * canonical. SPE-1976.
 */
export function handleEventStream(request: Request, response: Response): void {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  const sinceId = readSinceId(request);
  const bus = getEventBus();

  const writeFrame = (stamped: StampedEvent): void => {
    response.write(`id: ${stamped.id}\n`);
    response.write(`event: ${stamped.event.type}\n`);
    response.write(`data: ${JSON.stringify(stamped.event)}\n\n`);
  };

  const { replayed, gap, unsubscribe } = bus.subscribeSince(sinceId, writeFrame);

  if (gap) {
    response.write('event: gap\n');
    response.write('data: {"reason":"buffer-overflow"}\n\n');
  }

  for (const stamped of replayed) {
    writeFrame(stamped);
  }

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

  logger.debug(
    { listeners: bus.listenerCount(), sinceId, replayed: replayed.length, gap },
    'SSE client connected',
  );
}

function readSinceId(request: Request): number {
  const header = request.header('Last-Event-ID');
  if (header) {
    return parseId(header);
  }
  const since = request.query['since'];
  if (typeof since === 'string') {
    return parseId(since);
  }
  return 0;
}

function parseId(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
