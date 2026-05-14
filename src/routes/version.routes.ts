import { Router } from 'express';

import { handleGetVersion } from '../controllers/version.controller';

/**
 * `GET /api/version` — returns the cached agent_version hash and per-repo
 * breakdown. Bearer-gated at the parent mount in `routes/index.ts`.
 */
export function createVersionRoutes(): Router {
  const router = Router();
  router.get('/', handleGetVersion);
  return router;
}
