import type { Request, Response } from 'express';
import { z } from 'zod';

import { getStringParameter, getStringQuery } from '../lib/extract';
import { getLogger } from '../lib/logging';
import type { ResolvedAgent } from '../services/agent-loader.service';
import {
  CapExceededError,
  getScheduledTasksService,
  runnerConfigSchema,
} from '../services/scheduled-tasks.service';
import type { ScheduledTasksService } from '../services/scheduled-tasks.service';
import { agentPromptScheduleRequestSchema, whenSchema } from '../types/scheduled-task';

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

  const createdByRaw = getStringQuery(request, 'createdBy');
  if (createdByRaw !== undefined) {
    const parsed = createdBySchema.safeParse(createdByRaw);
    if (!parsed.success) {
      response
        .status(400)
        .json({ error: 'Invalid createdBy filter', details: parsed.error.issues });
      return;
    }
    filters.createdBy = parsed.data;
  }

  const agentIdRaw = getStringQuery(request, 'agentId');
  if (agentIdRaw !== undefined) filters.agentId = agentIdRaw;

  const traceRaw = getStringQuery(request, 'createdByTraceId');
  if (traceRaw !== undefined) filters.createdByTraceId = traceRaw;

  const limit = parseLimit(getStringQuery(request, 'limit'));
  const cursor = getStringQuery(request, 'cursor');

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
    if (error instanceof CapExceededError) {
      sendCapExceededResponse(response, error);
      return;
    }
    logger.error({ error: serializeError(error) }, 'Scheduled task create failed');
    response.status(500).json({ error: 'Internal error' });
  }
}

/**
 * `POST /api/scheduled-tasks/agent-prompt` — the agent-friendly facade
 * over `upsert` (SPE-2049). Accepts a verbatim `prompt` plus an optional
 * `useMemory` opt-in for fire-time RAG; the controller synthesises the
 * underlying `runner` + `runnerConfig` from the agent registry and
 * stores the prompt under `payload.directPrompt`. The task-worker takes
 * a verbatim-replay path on fire when it sees `directPrompt`, so no
 * `routing.schedule` rule is required to back this endpoint.
 */
export function createSchedulePromptHandler(agents: readonly ResolvedAgent[]) {
  return async (request: Request, response: Response): Promise<void> => {
    const parsed = agentPromptScheduleRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const agent = agents.find((candidate) => candidate.name === parsed.data.agentId);
    if (!agent) {
      response.status(404).json({ error: `Unknown agent: ${parsed.data.agentId}` });
      return;
    }

    // The agent-prompt path is fixed to claude-cli with the agent's
    // workspace as the work directory. Other runner types remain
    // available via the operator-only POST / endpoint above; the
    // agent-facing endpoint is intentionally narrower.
    const payload: Record<string, unknown> = {
      directPrompt: parsed.data.prompt,
      ...(parsed.data.useMemory !== undefined ? { useMemory: parsed.data.useMemory } : {}),
      ...(parsed.data.context ?? {}),
    };

    const registry = resolveRegistry();
    try {
      const task = await registry.upsert({
        agentId: parsed.data.agentId,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        when: parsed.data.when,
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: agent.dir },
        payload,
        ...(parsed.data.ttl !== undefined ? { ttl: parsed.data.ttl } : {}),
        ...(parsed.data.maxRuns !== undefined ? { maxRuns: parsed.data.maxRuns } : {}),
        createdByTraceId: parsed.data.traceId,
        createdBy: 'agent',
        reason: 'api-create',
      });
      response.status(201).json(task);
    } catch (error) {
      if (error instanceof CapExceededError) {
        sendCapExceededResponse(response, error);
        return;
      }
      logger.error({ error: serializeError(error) }, 'Scheduled agent-prompt create failed');
      response.status(500).json({ error: 'Internal error' });
    }
  };
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
    // Ownership gate (SPE-2049): when the request carries `?agentId=<id>`,
    // refuse to delete a record owned by a different agent. The 403
    // path returns BEFORE calling registry.delete so no
    // `scheduled-task.cancelled` event leaks — that prevents an agent
    // from probing for other agents' schedule via the SSE stream. The
    // operator path (no agentId) still does what it always did.
    const callerAgentId = readAgentIdQuery(request);
    if (callerAgentId !== undefined) {
      const existing = await registry.getById(id);
      if (!existing) {
        response.status(404).json({ error: 'Scheduled task not found' });
        return;
      }
      if (existing.agentId !== callerAgentId) {
        response.status(403).json({
          error: `Scheduled task ${id} is owned by agent "${existing.agentId}", not "${callerAgentId}"`,
        });
        return;
      }
    }

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
  return getStringParameter(request, 'id') ?? null;
}

function readAgentIdQuery(request: Request): string | undefined {
  return getStringQuery(request, 'agentId');
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Map a CapExceededError to its HTTP response. The shape carries `cap`,
 * `limit`, and `observed` verbatim so a Python client can branch on the
 * cap kind without parsing strings. Per-trace overflow is 429 (the
 * agent should back off and retry later); future-window overflow is
 * 422 (the agent's input is wrong, no amount of retry helps).
 */
function sendCapExceededResponse(response: Response, error: CapExceededError): void {
  const status = error.cap === 'per-trace' ? 429 : 422;
  response.status(status).json({
    error: error.message,
    cap: error.cap,
    limit: error.limit,
    observed: error.observed,
  });
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
