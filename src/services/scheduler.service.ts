import { getLogger } from '../lib/logging';
import type { ResolvedAgent } from './agent-loader.service';
import { getTaskQueue } from './task.service';

const logger = getLogger('scheduler');

const SCHEDULE_PROVIDER = 'schedule';

export interface RegisteredSchedule {
  readonly agent: string;
  readonly rule: string;
  readonly cron: string;
  readonly timezone?: string;
  readonly schedulerId: string;
}

/**
 * For each agent that declares `routing.schedule.rules`, register a
 * BullMQ JobScheduler so the rule's cron pattern fires repeatable jobs
 * onto the agent's existing task queue. The task-worker discriminates
 * scheduled fires from internal /api/tasks dispatches via the envelope's
 * `kind: 'scheduled'` field.
 *
 * Idempotent across restarts: BullMQ's `upsertJobScheduler` keys on the
 * scheduler id (we use `schedule:<agent>:<rule>`), so repeated calls
 * with the same options are a no-op. A changed cron pattern updates the
 * existing scheduler in place rather than registering a duplicate.
 *
 * Schedule rules are validated for required fields here, not at
 * agent-load time, because the same rule shape backs other providers
 * (routing.internal, routing.jira) where `cron` is irrelevant. Loud
 * config errors on schedule rules surface here.
 */
export async function registerAgentSchedules(
  agents: readonly ResolvedAgent[],
): Promise<readonly RegisteredSchedule[]> {
  const registered: RegisteredSchedule[] = [];
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
      if (!rule.messageTemplate) {
        throw new Error(
          `Agent "${agent.name}" routing.schedule rule "${ruleName}" is missing a "messageTemplate" field.`,
        );
      }

      const queue = getTaskQueue(agent.name);
      const schedulerId = `schedule:${agent.name}:${ruleName}`;
      const data = JSON.stringify({
        kind: 'scheduled',
        rule: ruleName,
        context: rule.context ?? {},
      });

      // BullMQ's repeat options accept `pattern` (cron) and `tz`
      // (IANA name). DST shifts are handled by the underlying
      // cron-parser when `tz` is set.
      const repeatOpts = rule.timezone
        ? { pattern: rule.cron, tz: rule.timezone }
        : { pattern: rule.cron };

      await queue.upsertJobScheduler(schedulerId, repeatOpts, {
        name: ruleName,
        data,
        opts: {
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      });

      logger.info(
        {
          agent: agent.name,
          rule: ruleName,
          cron: rule.cron,
          timezone: rule.timezone,
          schedulerId,
        },
        'schedule.registered',
      );
      registered.push({
        agent: agent.name,
        rule: ruleName,
        cron: rule.cron,
        timezone: rule.timezone,
        schedulerId,
      });
    }
  }
  return registered;
}
