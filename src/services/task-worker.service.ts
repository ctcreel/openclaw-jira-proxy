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
import type { AgentRule, ResolvedAgent } from './agent-loader.service';
import {
  buildTaskQueueName,
  isScheduledEnvelope,
  parseTaskEnvelope,
  type InternalTaskEnvelope,
  type ScheduledTaskEnvelope,
} from './task.service';

const logger = getLogger('task-worker');
const INTERNAL_PROVIDER = 'internal';
const SCHEDULE_PROVIDER = 'schedule';

interface TaskRunSummary {
  runId: string;
  status: 'ok' | 'error' | 'timeout';
  error?: string;
}

async function processTask(job: Job<string>, agent: ResolvedAgent): Promise<TaskRunSummary> {
  const envelope = parseTaskEnvelope(job.data);
  if (isScheduledEnvelope(envelope)) {
    return processScheduledTask(envelope, agent);
  }
  return processInternalTask(envelope, agent);
}

async function processInternalTask(
  envelope: InternalTaskEnvelope,
  agent: ResolvedAgent,
): Promise<TaskRunSummary> {
  logger.info(
    { taskId: envelope.taskId, agent: agent.name, taskType: envelope.taskType },
    'Processing internal task',
  );

  const payload = { taskType: envelope.taskType, ...envelope.context };
  const rules = agent.config.routing[INTERNAL_PROVIDER]?.rules ?? [];
  const matched = rules.find(
    (rule) => rule.condition && evaluateCondition(payload, rule.condition),
  );

  if (!matched) {
    throw new Error(`No internal routing rule matched taskType=${envelope.taskType}`);
  }

  return runRule(matched, payload, agent, {
    sessionKey: `agent:${agent.name}:task-${envelope.taskId}`,
    traceId: envelope.taskId,
    jobId: envelope.taskId,
  });
}

async function processScheduledTask(
  envelope: ScheduledTaskEnvelope,
  agent: ResolvedAgent,
): Promise<TaskRunSummary> {
  const traceId = `schedule-${agent.name}-${envelope.rule}-${Date.now()}`;
  logger.info({ traceId, agent: agent.name, rule: envelope.rule }, 'Processing scheduled task');

  const rules = agent.config.routing[SCHEDULE_PROVIDER]?.rules ?? [];
  const matched = rules.find((rule) => rule.name === envelope.rule);

  if (!matched) {
    throw new Error(`No schedule rule named "${envelope.rule}" found for agent ${agent.name}`);
  }

  const payload = {
    kind: 'scheduled' as const,
    rule: envelope.rule,
    ...envelope.context,
  };

  return runRule(matched, payload, agent, {
    sessionKey: `agent:${agent.name}:schedule-${envelope.rule}-${traceId}`,
    traceId,
    jobId: traceId,
  });
}

interface RunRuleOptions {
  readonly sessionKey: string;
  readonly traceId: string;
  readonly jobId: string;
}

async function runRule(
  rule: AgentRule,
  payload: Record<string, unknown>,
  agent: ResolvedAgent,
  runOpts: RunRuleOptions,
): Promise<TaskRunSummary> {
  let prompt: string;
  if (rule.messageTemplate) {
    const templateContent = await readFile(join(agent.dir, rule.messageTemplate), 'utf-8');
    prompt = await renderTemplate(templateContent, payload, agent.dir);
  } else {
    prompt = JSON.stringify(payload);
  }

  const settings = getSettings();
  const runnerName = 'claude-cli'; // Tasks use the default runner; per-agent override via config is a follow-up.
  const runner = getRunner(runnerName);

  const result = await runner.run({
    prompt,
    sessionKey: runOpts.sessionKey,
    agentId: agent.name,
    model: undefined,
    timeoutMs: settings.agentWaitTimeoutMs,
    traceId: runOpts.traceId,
    jobId: runOpts.jobId,
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
  const scheduleRules = agent.config.routing[SCHEDULE_PROVIDER]?.rules ?? [];
  if (internalRules.length === 0 && scheduleRules.length === 0) {
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
