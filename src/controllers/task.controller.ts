import type { Request, Response } from 'express';
import { z } from 'zod';

import { getStringQuery } from '../lib/extract';
import { getLogger } from '../lib/logging';
import type { ResolvedAgent } from '../services/agent-loader.service';
import {
  createTask,
  getTaskStatus,
  UnknownAgentError,
  waitForTask,
} from '../services/task.service';

const logger = getLogger('task-controller');

const taskRequestSchema = z.object({
  agent: z.string().min(1),
  taskType: z.string().min(1),
  context: z.record(z.string(), z.unknown()).optional(),
});

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60_000;

// Bearer auth lives in the shared `requireAgentBearer` middleware
// (`src/middleware/bearer-auth.middleware.ts`). It's mounted at the
// route level in `routes/index.ts`, so handlers below assume the
// request is already authenticated. Keeping handlers focused on
// business logic — Bearer concerns belong to the middleware seam.

export function createTaskHandler(agents: readonly ResolvedAgent[]) {
  return async (request: Request, response: Response): Promise<void> => {
    const parseResult = taskRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      response
        .status(400)
        .json({ error: 'Invalid task request', details: parseResult.error.issues });
      return;
    }

    try {
      const { taskId, agent } = await createTask(parseResult.data, agents);
      response.status(202).json({
        taskId,
        agent,
        statusUrl: `/api/tasks/${agent}/${taskId}`,
        waitUrl: `/api/tasks/${agent}/${taskId}/wait`,
      });
    } catch (error) {
      if (error instanceof UnknownAgentError) {
        response.status(404).json({ error: error.message });
        return;
      }
      logger.error({ error }, 'createTask failed unexpectedly');
      throw error;
    }
  };
}

export function getTaskStatusHandler() {
  return async (request: Request, response: Response): Promise<void> => {
    const { agent, taskId } = request.params as { agent: string; taskId: string };
    const result = await getTaskStatus(agent, taskId);
    response.status(200).json(result);
  };
}

export function waitTaskHandler() {
  return async (request: Request, response: Response): Promise<void> => {
    const { agent, taskId } = request.params as { agent: string; taskId: string };
    const timeoutMs = clampTimeout(getStringQuery(request, 'timeoutMs'));
    const result = await waitForTask(agent, taskId, timeoutMs);
    response.status(200).json(result);
  };
}

function clampTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(parsed, MAX_WAIT_TIMEOUT_MS);
}
