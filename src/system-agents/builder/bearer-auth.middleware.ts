import type { NextFunction, Request, Response } from 'express';

import { getLogger } from '../../lib/logging';
import { getSecretManager } from '../../secrets/manager';
import { bearerStrategy } from '../../strategies/signature';
import { BUILDER_INTERNAL_BEARER_SECRET_KEY } from '../providers';

const logger = getLogger('builder-bearer-auth');

/**
 * Express middleware gating Builder's callback and deploy-complete
 * routes on `Authorization: Bearer <BUILDER_INTERNAL_BEARER>`.
 * The dispatch route is gated by the existing webhook handler via the
 * `bearer` signature strategy — only the admin-style routes (which don't
 * flow through the webhook ingestion pipeline) need this middleware.
 *
 * Uses the same timing-safe `bearerStrategy` as the dispatch path so the
 * comparison shape is consistent. Returns 401 on missing or invalid
 * tokens.
 */
// noqa: NAMING001
export function requireBuilderInternalBearer(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const secretManager = getSecretManager();
  if (!secretManager.hasSecret(BUILDER_INTERNAL_BEARER_SECRET_KEY)) {
    logger.error(
      { key: BUILDER_INTERNAL_BEARER_SECRET_KEY },
      'Internal-bearer secret not configured; rejecting request',
    );
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const expected = secretManager.getSecret(BUILDER_INTERNAL_BEARER_SECRET_KEY);
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const empty = Buffer.alloc(0);
  if (!bearerStrategy.validate(empty, header, expected)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
