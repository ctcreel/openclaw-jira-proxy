import { Router } from 'express';

import {
  deleteMemoryEntry,
  postMemorySearch,
  postMemoryStore,
} from '../controllers/memory.controller';

/**
 * `/api/memory` — store, search, delete. Authenticated via the same
 * `CLAWNDOM_AGENT_TOKEN` mechanism as `/api/tasks`. Templates running
 * inside agent runs call these via the `agency_tools.memory` Python
 * client.
 */
export function createMemoryRoutes(): Router {
  const router = Router();
  router.post('/store', postMemoryStore);
  router.post('/search', postMemorySearch);
  router.delete('/:id', deleteMemoryEntry);
  return router;
}
