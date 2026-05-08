import { Router } from 'express';

import {
  createScheduledTask,
  createSchedulePromptHandler,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
} from '../controllers/scheduled-tasks.controller';
import type { ResolvedAgent } from '../services/agent-loader.service';

/**
 * `/api/scheduled-tasks` — CRUD over the registry. Bearer auth (via the
 * shared `requireAgentBearer` middleware) is mounted at the route-level
 * in `routes/index.ts` so every handler is gated identically. Templates
 * call these via the `agency_tools.scheduled_tasks` Python client (Phase 3).
 *
 * The `agents` array is forwarded to the agent-prompt facade endpoint so
 * the controller can resolve `agent.dir` (for the synthesised
 * `runnerConfig.workDirectory`) and the agent's default memory
 * namespace (when `useMemory: true` is passed without an override).
 */
export function createScheduledTasksRoutes(agents: readonly ResolvedAgent[]): Router {
  const router = Router();
  router.get('/', listScheduledTasks);
  router.post('/', createScheduledTask);
  // Agent-prompt facade: a thin wrapper that synthesises runner +
  // runnerConfig from the agent registry and stores the prompt as
  // payload.directPrompt for the worker's verbatim-replay path.
  router.post('/agent-prompt', createSchedulePromptHandler(agents));
  router.get('/:id', getScheduledTask);
  router.delete('/:id', deleteScheduledTask);
  return router;
}
