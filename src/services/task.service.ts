import { randomUUID } from 'node:crypto';

import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { z } from 'zod';

import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import type { ResolvedAgent } from './agent-loader.service';
import { buildQueueName } from './queue.service';

const logger = getLogger('task-service');

export interface TaskRequest {
  agent: string;
  taskType: string;
  context?: Record<string, unknown>;
}

const TaskEnvelopeSchema = z.object({
  taskId: z.string(),
  taskType: z.string(),
  context: z.record(z.string(), z.unknown()),
});

export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unknown';

export interface TaskStatusResponse {
  taskId: string;
  status: TaskStatus;
  runId?: string;
  error?: string;
  returnValue?: unknown;
}

export function buildTaskQueueName(agentName: string): string {
  return buildQueueName(`tasks:${agentName}`);
}

interface TaskQueueBundle {
  queue: Queue;
  queueEvents: QueueEvents;
}

/**
 * Connection registry keyed by agent name. Each agent has one queue
 * client and one QueueEvents client; reused across createTask,
 * getTaskStatus, and waitForTask.
 */
const queueByAgent = new Map<string, TaskQueueBundle>();

function openQueue(agentName: string): TaskQueueBundle {
  const cached = queueByAgent.get(agentName);
  if (cached) return cached;

  const settings = getSettings();
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });
  const eventsConnection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });
  const queueName = buildTaskQueueName(agentName);
  const bundle: TaskQueueBundle = {
    queue: new Queue(queueName, { connection }),
    queueEvents: new QueueEvents(queueName, { connection: eventsConnection }),
  };
  queueByAgent.set(agentName, bundle);
  return bundle;
}

export async function closeTaskQueues(): Promise<void> {
  for (const bundle of queueByAgent.values()) {
    await bundle.queue.close();
    await bundle.queueEvents.close();
  }
  queueByAgent.clear();
}

export async function createTask(
  request: TaskRequest,
  agents: readonly ResolvedAgent[],
): Promise<{ taskId: string; agent: string }> {
  const agent = agents.find((candidate) => candidate.name === request.agent);
  if (!agent) {
    throw new UnknownAgentError(request.agent);
  }

  const envelope: TaskEnvelope = {
    taskId: randomUUID(),
    taskType: request.taskType,
    context: request.context ?? {},
  };

  const { queue } = openQueue(agent.name);
  await queue.add('internal-task', JSON.stringify(envelope), { jobId: envelope.taskId });

  logger.info(
    { taskId: envelope.taskId, agent: agent.name, taskType: envelope.taskType },
    'Internal task enqueued',
  );

  return { taskId: envelope.taskId, agent: agent.name };
}

export async function getTaskStatus(
  agentName: string,
  taskId: string,
): Promise<TaskStatusResponse> {
  const { queue } = openQueue(agentName);
  const job = await queue.getJob(taskId);
  if (!job) {
    return { taskId, status: 'unknown' };
  }

  const state = await job.getState();
  const status = mapBullStateToTaskStatus(state);

  const response: TaskStatusResponse = { taskId, status };
  if (job.returnvalue !== undefined) {
    response.returnValue = job.returnvalue;
  }
  if (job.failedReason) {
    response.error = job.failedReason;
  }
  return response;
}

export async function waitForTask(
  agentName: string,
  taskId: string,
  timeoutMs: number,
): Promise<TaskStatusResponse> {
  const { queue, queueEvents } = openQueue(agentName);
  const job = await queue.getJob(taskId);
  if (!job) {
    return { taskId, status: 'unknown' };
  }

  try {
    const returnValue = await job.waitUntilFinished(queueEvents, timeoutMs);
    return { taskId, status: 'completed', returnValue };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const currentState = await job.getState();
    const status = mapBullStateToTaskStatus(currentState);
    return { taskId, status, error: message };
  }
}

function mapBullStateToTaskStatus(state: string): TaskStatus {
  switch (state) {
    case 'waiting':
    case 'delayed':
    case 'paused':
      return 'queued';
    case 'active':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

export class UnknownAgentError extends Error {
  constructor(agentName: string) {
    super(`Unknown agent: ${agentName}`);
    this.name = 'UnknownAgentError';
  }
}

/**
 * Test helper — reset the queue registry so each test gets its own
 * connection state. Safe to call in beforeEach.
 */
export function resetTaskQueues(): void {
  queueByAgent.clear();
}

export function parseTaskEnvelope(data: string): TaskEnvelope {
  const result = TaskEnvelopeSchema.safeParse(JSON.parse(data));
  if (!result.success) {
    throw new Error('Invalid task envelope');
  }
  return result.data;
}

export type { Job } from 'bullmq';
