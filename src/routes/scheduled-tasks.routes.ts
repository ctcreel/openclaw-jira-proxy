import { Router } from 'express';

import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
} from '../controllers/scheduled-tasks.controller';

/**
 * `/api/scheduled-tasks` — CRUD over the registry. Bearer auth (via the
 * shared `requireAgentBearer` middleware) is mounted at the route-level
 * in `routes/index.ts` so every handler is gated identically. Templates
 * call these via the `agency_tools.scheduled_tasks` Python client (Phase 3).
 */
export function createScheduledTasksRoutes(): Router {
  const router = Router();
  router.get('/', listScheduledTasks);
  router.post('/', createScheduledTask);
  router.get('/:id', getScheduledTask);
  router.delete('/:id', deleteScheduledTask);
  return router;
}
