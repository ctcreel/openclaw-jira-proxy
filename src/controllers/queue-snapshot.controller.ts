import type { Request, Response } from 'express';

import { getLogger } from '../lib/logging';
import { buildQueueSnapshot } from '../services/queue-snapshot.service';

const logger = getLogger('queue-snapshot-controller');

/**
 * GET /api/queue/snapshot
 *
 * One-shot bootstrap for clients (the dashboard primarily) that need to
 * hydrate active + waiting + recently-completed state before subscribing to
 * `/api/events`. Returns the EventBus's `latestEventId` alongside the
 * snapshot so the client can set `Last-Event-ID` on the SSE connect and
 * pick up exactly where the snapshot ended. SPE-1976.
 */
export async function handleQueueSnapshot(_request: Request, response: Response): Promise<void> {
  try {
    const snapshot = await buildQueueSnapshot();
    response.json(snapshot);
  } catch (error) {
    logger.error({ error }, 'Failed to build queue snapshot');
    response.status(500).json({ error: 'snapshot-failed' });
  }
}
