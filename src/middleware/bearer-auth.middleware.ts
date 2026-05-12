import type { NextFunction, Request, Response } from 'express';

import { getSettings } from '../config';
import { getStringHeader } from '../lib/extract';
import { getLogger } from '../lib/logging';

const logger = getLogger('bearer-auth');
const BEARER_PREFIX = 'Bearer ';

/**
 * Express middleware that gates a router on `Authorization: Bearer
 * <CLAWNDOM_AGENT_TOKEN>`. Replaces the per-controller inline
 * `authenticate()` copies in `task.controller.ts` and `memory.controller.ts`
 * — same Bearer + 401-on-failure behaviour, single source of truth.
 *
 * The token is read from settings on every call rather than captured at
 * middleware-construction time, so a settings reset (test-suite) takes
 * effect immediately. If the token isn't configured, every request is
 * rejected — never silently allowed through.
 */
// noqa: NAMING001
export function requireAgentBearer(request: Request, response: Response, next: NextFunction): void {
  const expected = getSettings().agentToken;
  if (!expected) {
    logger.error('CLAWNDOM_AGENT_TOKEN is not configured; rejecting request');
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const header = getStringHeader(request, 'authorization');
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = header.slice(BEARER_PREFIX.length);
  if (token !== expected) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
