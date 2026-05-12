import type { Request, Response } from 'express';

import { getStringQuery } from '../lib/extract';
import { getSkippedWebhooksRegistry } from '../services/skipped-webhooks.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  // Clamp to [0, MAX_LIMIT] — registry also clamps, but doing it here keeps
  // the response bounded even if the registry capacity ever changes.
  return Math.max(0, Math.min(MAX_LIMIT, parsed));
}

/**
 * GET /api/webhooks/skipped/recent?limit=50
 *
 * Returns the most-recent rejected webhooks plus a breakdown of total
 * counts by reason. Lets a dashboard answer "what got dropped, and why?"
 * without grepping logs. Live updates flow over SSE; this endpoint exists
 * so a dashboard that reconnects can seed its panel without losing
 * pre-connect history.
 */
export function listRecentSkippedWebhooks(request: Request, response: Response): void {
  const registry = getSkippedWebhooksRegistry();
  const limit = parseLimit(getStringQuery(request, 'limit'));
  response.json({
    skipped: registry.listRecent(limit),
    counts: registry.getCounts(),
  });
}
