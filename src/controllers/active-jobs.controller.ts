import type { Request, Response } from 'express';

import { getActiveJobsRegistry } from '../services/active-jobs.service';

/**
 * GET /api/jobs/active
 *
 * Snapshot of currently-running jobs, for clients that need to bootstrap
 * their view before subscribing to `/api/events`. The SSE stream is
 * live-only, so a client that connects mid-run can't recover what it
 * missed. This endpoint closes that gap: fetch it on startup, merge into
 * local state, then rely on SSE for everything after.
 */
export function listActiveJobs(_request: Request, response: Response): void {
  const registry = getActiveJobsRegistry();
  response.json({ jobs: registry.listActive() });
}
