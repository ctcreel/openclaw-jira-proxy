import type { Request, Response } from 'express';
import { z } from 'zod';

import { getLogger } from '../lib/logging';
import { getScheduledTasksService, runnerConfigSchema } from '../services/scheduled-tasks.service';
import type { ScheduledTasksService } from '../services/scheduled-tasks.service';
import { whenSchema } from '../types/scheduled-task';

const logger = getLogger('scheduled-tasks-controller');

/**
 * Cap aligns with the registry's MAX_PAGE_SIZE so a 500-record page can't
 * land on the wire when the registry would have clamped it anyway —
 * client errors with a clear hint rather than silently truncating.
 */
const MAX_LIMIT = 200;

/**
 * `runner: shell` is rejected at the controller layer (defense-in-depth).
 * The registry would happily accept it, but a remote-create endpoint is
 * the one place we don't want shell injection — agents can already shell
 * out via their own runner config; we don't need a network-exposed
 * `?command=...` paving stone.
 */
const createScheduledTaskSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1).optional(),
  when: whenSchema,
  runner: z.string().min(1),
  runnerConfig: runnerConfigSchema.refine((config) => config.type !== 'shell', {
    message:
      'Shell runner is not allowed via the public API — declare shell tasks in clawndom.yaml under routing.schedule.',
  }),
  payload: z.record(z.string(), z.unknown()).optional(),
  ttl: z.number().int().nonnegative().optional(),
  maxRuns: z.number().int().positive().optional(),
  createdByTraceId: z.string().min(1).optional(),
});

const createdBySchema = z.enum(['config', 'agent']);

/**
 * Test seam — production code path is `getScheduledTasksService()`. Tests
 * inject a stub via the setter so the HTTP layer can be exercised
 * without a live Redis or BullMQ.
 */
let registryOverrideForTesting: ScheduledTasksService | null = null;

export function setScheduledTasksRegistryForTests(stub: ScheduledTasksService | null): void {
  registryOverrideForTesting = stub;
}

function resolveRegistry(): ScheduledTasksService {
  return registryOverrideForTesting ?? getScheduledTasksService();
}

export async function listScheduledTasks(request: Request, response: Response): Promise<void> {
  const registry = resolveRegistry();
  const filters: {
    createdBy?: 'config' | 'agent';
    agentId?: string;
    createdByTraceId?: string;
  } = {};

  const createdByRaw = request.query['createdBy'];
  if (typeof createdByRaw === 'string') {
    const parsed = createdBySchema.safeParse(createdByRaw);
    if (!parsed.success) {
      response
        .status(400)
        .json({ error: 'Invalid createdBy filter', details: parsed.error.issues });
      return;
    }
    filters.createdBy = parsed.data;
  }

  const agentIdRaw = request.query['agentId'];
  if (typeof agentIdRaw === 'string' && agentIdRaw.length > 0) {
    filters.agentId = agentIdRaw;
  }

  const traceRaw = request.query['createdByTraceId'];
  if (typeof traceRaw === 'string' && traceRaw.length > 0) {
    filters.createdByTraceId = traceRaw;
  }

  const limit = parseLimit(request.query['limit']);
  const cursor = typeof request.query['cursor'] === 'string' ? request.query['cursor'] : undefined;

  try {
    const page = await registry.list(filters, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    response.status(200).json({
      tasks: page.tasks,
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    logger.error({ error: serializeError(error) }, 'Scheduled task list failed');
    response.status(500).json({ error: 'Internal error' });
  }
}

export async function createScheduledTask(request: Request, response: Response): Promise<void> {
  const parsed = createScheduledTaskSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const registry = resolveRegistry();
  try {
    const task = await registry.upsert({
      agentId: parsed.data.agentId,
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      when: parsed.data.when,
      runner: parsed.data.runner,
      runnerConfig: parsed.data.runnerConfig,
      ...(parsed.data.payload !== undefined ? { payload: parsed.data.payload } : {}),
      ...(parsed.data.ttl !== undefined ? { ttl: parsed.data.ttl } : {}),
      ...(parsed.data.maxRuns !== undefined ? { maxRuns: parsed.data.maxRuns } : {}),
      ...(parsed.data.createdByTraceId !== undefined
        ? { createdByTraceId: parsed.data.createdByTraceId }
        : {}),
      createdBy: 'agent',
      reason: 'api-create',
    });
    response.status(201).json(task);
  } catch (error) {
    logger.error({ error: serializeError(error) }, 'Scheduled task create failed');
    response.status(500).json({ error: 'Internal error' });
  }
}

export async function getScheduledTask(request: Request, response: Response): Promise<void> {
  const id = readIdParameter(request);
  if (!id) {
    response.status(400).json({ error: 'Missing :id path parameter' });
    return;
  }
  const registry = resolveRegistry();
  try {
    const task = await registry.getById(id);
    if (!task) {
      response.status(404).json({ error: 'Scheduled task not found' });
      return;
    }
    response.status(200).json(task);
  } catch (error) {
    logger.error({ id, error: serializeError(error) }, 'Scheduled task fetch failed');
    response.status(500).json({ error: 'Internal error' });
  }
}

export async function deleteScheduledTask(request: Request, response: Response): Promise<void> {
  const id = readIdParameter(request);
  if (!id) {
    response.status(400).json({ error: 'Missing :id path parameter' });
    return;
  }
  const registry = resolveRegistry();
  try {
    const result = await registry.delete(id, { reason: 'api-delete' });
    if (!result.removed) {
      response.status(404).json({ error: 'Scheduled task not found' });
      return;
    }
    response.status(204).send();
  } catch (error) {
    logger.error({ id, error: serializeError(error) }, 'Scheduled task delete failed');
    response.status(500).json({ error: 'Internal error' });
  }
}

function readIdParameter(request: Request): string | null {
  const raw = request.params['id'];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
}

function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, MAX_LIMIT);
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
