import { getLogger } from '../lib/logging';
import type { RunnerConfig } from '../runners/types';
import { deriveConfigTaskId } from '../types/scheduled-task';
import type { ScheduledTaskWhen } from '../types/scheduled-task';
import type { ResolvedAgent } from './agent-loader.service';
import { getScheduledTasksService } from './scheduled-tasks.service';
import { getTaskQueue } from './task.service';

const logger = getLogger('scheduler');

const SCHEDULE_PROVIDER = 'schedule';
const LEGACY_SCHEDULER_PREFIX = 'schedule:';

export interface RegisteredSchedule {
  readonly agent: string;
  readonly rule: string;
  readonly cron: string;
  readonly timezone?: string;
  readonly schedulerId: string;
  /**
   * Registry task id (16 hex chars). Stable across restarts because it's
   * a content hash over `{agentId, name, when, runner, runnerConfig}`.
   * Surfaced in the return so callers (currently `startServer`) can log
   * the registry id alongside the BullMQ scheduler id during boot.
   */
  readonly taskId: string;
}

/**
 * For each agent that declares `routing.schedule.rules`, register a
 * scheduled-task in the registry. The registry adapter writes a BullMQ
 * JobScheduler under the hood (`scheduled-task-<id>`) and keeps a
 * Redis-backed record so the config-reconcile sweep at the end of this
 * function can delete orphans (rules removed from the agent yaml since
 * the last boot).
 *
 * Idempotent across restarts: identical rule → identical content-hash id
 * → registry upsert is a no-op (no `scheduled-task.created` event fires
 * on re-registration). Removed rules → reconcile sees them missing from
 * `loadedIds` and emits `scheduled-task.cancelled` with reason
 * `config-reconcile` while cleaning up the BullMQ scheduler.
 *
 * One-time migration: pre-Phase-2 deploys keyed BullMQ schedulers by
 * `schedule:<agent>:<rule>`. We strip those on every boot so a rolling
 * deploy never double-fires (legacy + new). The call is a no-op once
 * the migration has run, so it's safe to leave in indefinitely.
 *
 * Schedule-rule shape errors (missing name/cron/messageTemplate) still
 * throw here rather than at agent-load time — `routing.schedule` rules
 * share their schema with other providers' rules, where those fields
 * are optional. Loud config errors on schedule rules surface here.
 */
export async function registerAgentSchedules(
  agents: readonly ResolvedAgent[],
): Promise<readonly RegisteredSchedule[]> {
  const service = getScheduledTasksService();
  const registered: RegisteredSchedule[] = [];
  const loadedIds = new Set<string>();

  for (const agent of agents) {
    const rules = agent.config.routing[SCHEDULE_PROVIDER]?.rules ?? [];
    for (const rule of rules) {
      const ruleName = rule.name;
      if (!ruleName) {
        throw new Error(
          `Agent "${agent.name}" has a routing.schedule rule without a "name" field — schedule rules must be named so the scheduler can dispatch them.`,
        );
      }
      if (!rule.cron) {
        throw new Error(
          `Agent "${agent.name}" routing.schedule rule "${ruleName}" is missing a "cron" field.`,
        );
      }
      // Shell-runner rules execute a configured command instead of an
      // LLM prompt — they don't render a template, so the requirement
      // doesn't apply. Every other runner type still needs one.
      if (!rule.messageTemplate && rule.runner?.type !== 'shell') {
        throw new Error(
          `Agent "${agent.name}" routing.schedule rule "${ruleName}" is missing a "messageTemplate" field.`,
        );
      }

      // Legacy id cleanup. Pre-Phase-2 the scheduler keyed BullMQ jobs
      // by `schedule:<agent>:<rule>`. The new key is `scheduled-task-<id>`,
      // so a rolling deploy without this step would have both schedulers
      // firing the same rule. Removing the legacy id is idempotent —
      // `removeJobScheduler` returns false when the id doesn't exist.
      await removeLegacyScheduler(agent.name, ruleName);

      const when = buildWhen(rule.cron, rule.timezone);
      const runnerConfig = resolveRunnerConfig(rule.runner, agent);
      const runnerName = runnerConfig.type;

      const taskId = deriveConfigTaskId({
        agentId: agent.name,
        name: ruleName,
        when,
        runner: runnerName,
        runnerConfig,
      });

      await service.upsert({
        id: taskId,
        agentId: agent.name,
        name: ruleName,
        when,
        runner: runnerName,
        runnerConfig,
        payload: rule.context ?? {},
        createdBy: 'config',
        reason: 'config-load',
      });
      loadedIds.add(taskId);

      const schedulerId = `scheduled-task-${taskId}`;
      logger.info(
        {
          agent: agent.name,
          rule: ruleName,
          cron: rule.cron,
          timezone: rule.timezone,
          schedulerId,
          taskId,
        },
        'schedule.registered',
      );
      registered.push({
        agent: agent.name,
        rule: ruleName,
        cron: rule.cron,
        timezone: rule.timezone,
        schedulerId,
        taskId,
      });
    }
  }

  // Reconcile: any `createdBy=config` registry record not seen in this
  // pass corresponds to a rule that was removed from the agent yaml
  // since the last boot. The registry deletes the record + emits
  // `scheduled-task.cancelled` with reason `config-reconcile` and the
  // BullMQ adapter cleans up the underlying scheduler.
  const orphans = await service.reconcileConfig(loadedIds);
  if (orphans.length > 0) {
    logger.info({ count: orphans.length, ids: orphans }, 'schedule.reconciled');
  }

  return registered;
}

function buildWhen(cron: string, timezone: string | undefined): ScheduledTaskWhen {
  return timezone ? { cron, timezone } : { cron };
}

/**
 * Resolve the runner config for a schedule rule. Rules without an
 * explicit `runner` field inherit the legacy default (`claude-cli`
 * pointed at the agent workspace) — same fallback the task-worker
 * applies at fire time, hoisted forward so the registry sees a concrete
 * runner config. Without this, the content-hash id would be derived
 * from a `null` runnerConfig and shift the moment a default-runner rule
 * gained an explicit `runner` block.
 */
function resolveRunnerConfig(
  ruleRunner: RunnerConfig | undefined,
  agent: ResolvedAgent,
): RunnerConfig {
  if (ruleRunner) return ruleRunner;
  return { type: 'claude-cli', workDirectory: agent.dir };
}

async function removeLegacyScheduler(agentName: string, ruleName: string): Promise<void> {
  try {
    const queue = getTaskQueue(agentName);
    await queue.removeJobScheduler(`${LEGACY_SCHEDULER_PREFIX}${agentName}:${ruleName}`);
  } catch (error) {
    // Legacy scheduler usually doesn't exist on a fresh deploy — silent
    // at debug level so the migration's no-op case stays out of info logs.
    logger.debug(
      { agent: agentName, rule: ruleName, error: serializeError(error) },
      'Legacy scheduler removal skipped',
    );
  }
}

function serializeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
