import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import { renderTemplate } from '../lib/template/template-engine';
import { getRunner } from '../runners/registry';
import { ShellRunner } from '../runners/shell.runner';
import type { AgentRunner, RunResult } from '../runners/types';
import { evaluateCondition } from '../strategies/routing';
import { useMemorySchema, type UseMemory } from '../types/scheduled-task';
import {
  getAgentDefaultMemoryNamespace,
  type AgentRule,
  type ResolvedAgent,
} from './agent-loader.service';
import { getMemoryService } from './memory/memory.service';
import { renderMemoryRecallBlock } from './memory/prompt-fragments';
import type { MemoryHit } from './memory/prompt-fragments';
import { getScheduledTasksService } from './scheduled-tasks.service';
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
    return processScheduledTask(envelope, agent, job);
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
  job: Job<string>,
): Promise<TaskRunSummary> {
  const traceId = `schedule-${agent.name}-${envelope.rule}-${Date.now()}`;
  logger.info({ traceId, agent: agent.name, rule: envelope.rule }, 'Processing scheduled task');

  // Fire-time accounting through the registry — increments runCount,
  // recomputes nextFireAt for cron tasks, and emits scheduled-task.fired.
  // If the task has expired (ttl reached or maxRuns hit), the registry
  // returns shouldFire:false and emits scheduled-task.expired; we skip
  // the run and let BullMQ mark the job complete. taskId is optional on
  // the envelope so legacy in-flight jobs (queued before this deploy)
  // skip the registry entirely and run as before.
  if (envelope.taskId !== undefined) {
    const registry = getScheduledTasksService();
    const fireResult = await registry.recordFire({
      id: envelope.taskId,
      jobId: job.id ?? traceId,
      traceId,
    });
    if (!fireResult.shouldFire) {
      logger.info(
        {
          traceId,
          agent: agent.name,
          rule: envelope.rule,
          taskId: envelope.taskId,
          expiredReason: fireResult.expiredReason,
        },
        'Scheduled task skipped (expired or unknown to registry)',
      );
      return { runId: traceId, status: 'ok' };
    }
  }

  // Agent-prompt path (SPE-2049): when the registry payload carries a
  // `directPrompt`, deliver it verbatim to the runner — no rule lookup,
  // no template render. Optional `useMemory` triggers fire-time RAG;
  // results land in a recall block ABOVE the prompt so the prompt's
  // own framing remains the recency-biased tail.
  const directPrompt = readDirectPrompt(envelope.context);
  if (directPrompt !== undefined) {
    return runDirectPrompt(directPrompt, envelope, agent, {
      sessionKey: `agent:${agent.name}:schedule-${envelope.taskId ?? envelope.rule}-${traceId}`,
      traceId,
      jobId: traceId,
    });
  }

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

/**
 * Verbatim-replay execution path for agent-created scheduled tasks
 * (SPE-2049). Bypasses the rule + template machinery and invokes the
 * runner directly with the stored prompt. Optional fire-time RAG is
 * woven in here — if we lifted it into runRule, every config-defined
 * schedule rule would inherit the behaviour, which we don't want.
 */
async function runDirectPrompt(
  directPrompt: string,
  envelope: ScheduledTaskEnvelope,
  agent: ResolvedAgent,
  runOpts: RunRuleOptions,
): Promise<TaskRunSummary> {
  const settings = getSettings();
  const useMemory = readUseMemory(envelope.context);
  const recallBlock = await buildRecallBlockIfRequested(
    useMemory,
    directPrompt,
    agent,
    runOpts.traceId,
  );
  // ABOVE the prompt: the agent-authored prompt stays the most recent
  // text, with retrieved memories serving as immediately-prior context.
  // Bottom-positioning would push the agent's own instructions away
  // from the model's generation point.
  const prompt = recallBlock !== undefined ? `${recallBlock}\n${directPrompt}` : directPrompt;

  const promptHash = createHash('sha256').update(prompt).digest('hex').slice(0, 12);
  logger.info(
    {
      jobId: runOpts.jobId,
      traceId: runOpts.traceId,
      runner: 'claude-cli',
      agent: agent.name,
      sessionKey: runOpts.sessionKey,
      promptHash,
      promptLength: prompt.length,
      systemPromptLength: 0,
      cacheable: false,
      directPrompt: true,
      withMemory: recallBlock !== undefined,
    },
    'Agent run delivered',
  );

  const runner = getRunner('claude-cli');
  const result = await runner.run({
    prompt,
    sessionKey: runOpts.sessionKey,
    agentId: agent.name,
    model: undefined,
    timeoutMs: settings.agentWaitTimeoutMs,
    traceId: runOpts.traceId,
    jobId: runOpts.jobId,
  });

  return mapRunResult(result);
}

/**
 * Run fire-time RAG when the stored task opted in via `useMemory`.
 * Returns the rendered recall block (with hits) or `undefined` to skip.
 *
 * The function is deliberately defensive — RAG is opt-in scaffolding
 * for the agent-prompt path, not the core firing semantics. A
 * configuration mistake (typoed namespace, missing memory block on the
 * agent) must NOT prevent the prompt from running. We log + return
 * undefined and the caller falls back to verbatim replay.
 */
async function buildRecallBlockIfRequested(
  useMemory: UseMemory | undefined,
  query: string,
  agent: ResolvedAgent,
  traceId: string,
): Promise<string | undefined> {
  if (useMemory === undefined || useMemory === false) return undefined;

  const settings = getSettings();
  const overrides = useMemory === true ? {} : useMemory;
  const namespace = overrides.namespace ?? getAgentDefaultMemoryNamespace(agent);
  if (namespace === undefined) {
    logger.info(
      { agent: agent.name, traceId },
      'useMemory requested but agent has no declared memory namespaces — skipping RAG',
    );
    return undefined;
  }

  const topK = overrides.topK ?? settings.scheduledTasksRagTopKDefault;
  const minSimilarity = overrides.minSimilarity ?? settings.scheduledTasksRagMinSimilarityDefault;

  let hits: readonly MemoryHit[] = [];
  try {
    const result = await getMemoryService().search({
      namespace,
      query,
      topK,
      minSimilarity,
      traceId,
    });
    hits = result.hits;
  } catch (error) {
    logger.warn(
      {
        agent: agent.name,
        namespace,
        traceId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Fire-time RAG failed — proceeding with verbatim prompt',
    );
    return undefined;
  }

  return renderMemoryRecallBlock({
    memories: hits,
    memoryNamespace: namespace,
    traceId,
  });
}

function readDirectPrompt(context: Record<string, unknown>): string | undefined {
  const value = context['directPrompt'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readUseMemory(context: Record<string, unknown>): UseMemory | undefined {
  const raw = context['useMemory'];
  if (raw === undefined) return undefined;
  const parsed = useMemorySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function mapRunResult(result: RunResult): TaskRunSummary {
  if (result.status === 'error') {
    throw new Error(`Task run failed: ${result.error ?? 'unknown'}`);
  }
  if (result.status === 'timeout') {
    throw new Error(`Task run timed out (runId: ${result.runId ?? 'unknown'})`);
  }
  if (result.status === 'quota_exceeded') {
    const resetAtIso =
      result.quotaResetAt === undefined ? 'unknown' : new Date(result.quotaResetAt).toISOString();
    throw new Error(`Task run hit upstream quota limit (resets at ${resetAtIso})`);
  }
  return { runId: result.runId ?? 'unknown', status: result.status };
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
  const { runner, prompt, systemPrompt } = await resolveRunnerAndPrompt(rule, payload, agent);
  const settings = getSettings();

  // Mirror the webhook-worker's "Agent run delivered" log so internal /
  // scheduled task firings have the same prompt-cache observability as
  // webhook-driven runs. Same field shape (promptHash, promptLength,
  // systemPromptLength, cacheable) so an operator's grep query works
  // uniformly across both dispatch paths.
  const promptHash = createHash('sha256').update(prompt).digest('hex').slice(0, 12);
  logger.info(
    {
      jobId: runOpts.jobId,
      traceId: runOpts.traceId,
      runner: runner.name,
      agent: agent.name,
      sessionKey: runOpts.sessionKey,
      promptHash,
      promptLength: prompt.length,
      systemPromptLength: systemPrompt.length,
      cacheable: systemPrompt.length > 0,
    },
    'Agent run delivered',
  );

  // Scheduled-task workflow doesn't yet have a quota-aware pause-and-hold
  // path (the webhook worker does — see worker.service.ts:handleQuotaExceeded).
  // For now surface quota_exceeded as an error so existing BullMQ retry
  // semantics apply; a follow-up can mirror the webhook side's
  // delayed-resume behaviour for scheduled tasks if recurring-fire quota
  // collisions become a problem.
  const result = await runner.run({
    prompt,
    sessionKey: runOpts.sessionKey,
    agentId: agent.name,
    model: undefined,
    timeoutMs: settings.agentWaitTimeoutMs,
    traceId: runOpts.traceId,
    jobId: runOpts.jobId,
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
  });

  return mapRunResult(result);
}

// Shell runners are constructed per-firing because their config (the
// command) varies per rule, not per deployment. Other runner types stay
// in the global registry: their configuration is fixed at startup.
//
// Exported for unit-testing the dispatch decision in isolation; the
// production callsite is `runRule` above.
export async function resolveRunnerAndPrompt(
  rule: AgentRule,
  payload: Record<string, unknown>,
  agent: ResolvedAgent,
): Promise<{ runner: AgentRunner; prompt: string; systemPrompt: string }> {
  if (rule.runner?.type === 'shell') {
    return {
      runner: new ShellRunner(rule.runner, agent.dir),
      prompt: '',
      systemPrompt: '',
    };
  }

  let prompt: string;
  let systemPrompt = '';
  if (rule.messageTemplate) {
    const templateContent = await readFile(join(agent.dir, rule.messageTemplate), 'utf-8');
    const rendered = await renderTemplate(templateContent, payload, agent.dir);
    prompt = rendered.body;
    systemPrompt = rendered.systemPrompt;
  } else {
    prompt = JSON.stringify(payload);
  }

  const runnerName = rule.runner?.type ?? 'claude-cli';
  return { runner: getRunner(runnerName), prompt, systemPrompt };
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
