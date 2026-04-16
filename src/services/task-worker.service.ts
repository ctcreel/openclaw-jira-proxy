import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import { renderTemplate } from '../lib/template/template-engine';
import { getRunner } from '../runners/registry';
import { evaluateCondition } from '../strategies/routing';
import type { ResolvedAgent } from './agent-loader.service';
import { buildTaskQueueName, parseTaskEnvelope } from './task.service';

const logger = getLogger('task-worker');
const INTERNAL_PROVIDER = 'internal';

interface TaskRunSummary {
  runId: string;
  status: 'ok' | 'error' | 'timeout';
  error?: string;
}

async function processTask(job: Job<string>, agent: ResolvedAgent): Promise<TaskRunSummary> {
  const envelope = parseTaskEnvelope(job.data);
  logger.info(
    { taskId: envelope.taskId, agent: agent.name, taskType: envelope.taskType },
    'Processing internal task',
  );

  const payload = { taskType: envelope.taskType, ...envelope.context };
  const rules = agent.config.routing[INTERNAL_PROVIDER]?.rules ?? [];
  const matched = rules.find((rule) => evaluateCondition(payload, rule.condition));

  if (!matched) {
    throw new Error(`No internal routing rule matched taskType=${envelope.taskType}`);
  }

  let prompt: string;
  if (matched.messageTemplate) {
    const templateContent = await readFile(join(agent.dir, matched.messageTemplate), 'utf-8');
    prompt = await renderTemplate(templateContent, payload, agent.dir);
  } else {
    prompt = JSON.stringify(payload);
  }

  const settings = getSettings();
  const runnerName = 'claude-cli'; // Internal tasks use the default runner; override via agent config in a follow-up
  const runner = getRunner(runnerName);

  const result = await runner.run({
    prompt,
    sessionKey: `agent:${agent.name}:task-${envelope.taskId}`,
    agentId: agent.name,
    model: undefined,
    timeoutMs: settings.agentWaitTimeoutMs,
    traceId: envelope.taskId,
    jobId: envelope.taskId,
  });

  if (result.status === 'error') {
    throw new Error(`Task run failed: ${result.error ?? 'unknown'}`);
  }
  if (result.status === 'timeout') {
    throw new Error(`Task run timed out (runId: ${result.runId ?? 'unknown'})`);
  }

  return {
    runId: result.runId ?? 'unknown',
    status: result.status,
  };
}

export function createTaskWorker(agent: ResolvedAgent): Worker<string> | null {
  const internalRules = agent.config.routing[INTERNAL_PROVIDER]?.rules ?? [];
  if (internalRules.length === 0) {
    return null;
  }

  const settings = getSettings();
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<string>(
    buildTaskQueueName(agent.name),
    (job) => processTask(job, agent),
    {
      connection,
      concurrency: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );

  logger.info({ agent: agent.name, queue: buildTaskQueueName(agent.name) }, 'Task worker started');
  return worker;
}
