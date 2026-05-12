import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

import IORedis from 'ioredis';
import type { Queue } from 'bullmq';

import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import type { RunnerConfig } from '../runners/types';
import { runnerConfigSchema } from '../runners/types';
import type {
  ScheduledTask,
  ScheduledTaskCreatedBy,
  ScheduledTaskWhen,
} from '../types/scheduled-task';
import { isCronWhen, isFireAtWhen, scheduledTaskSchema } from '../types/scheduled-task';
import type {
  ScheduledTaskCancelledReason,
  ScheduledTaskCreatedReason,
  ScheduledTaskExpiredReason,
} from '../types/clawndom-event';
import { getEventBus } from './event-bus.service';
import type { EventBus } from './event-bus.service';
import { getTaskQueue } from './task.service';

const logger = getLogger('scheduled-tasks');

const KEY_PREFIX = 'clawndom:scheduled-tasks';
const RECORD_KEY_PREFIX = `${KEY_PREFIX}:records`;
const BY_CREATED_BY_PREFIX = `${KEY_PREFIX}:by-createdBy`;
const BY_AGENT_PREFIX = `${KEY_PREFIX}:by-agent`;
const BY_TRACE_PREFIX = `${KEY_PREFIX}:by-trace`;
const NEXT_FIRE_KEY = `${KEY_PREFIX}:by-next-fire`;
const ALL_IDS_KEY = `${KEY_PREFIX}:all`;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface ScheduledTaskListFilters {
  readonly createdBy?: ScheduledTaskCreatedBy;
  readonly agentId?: string;
  readonly createdByTraceId?: string;
}

export interface ScheduledTaskListPage {
  readonly tasks: readonly ScheduledTask[];
  readonly nextCursor: string | null;
}

export interface CreateScheduledTaskInput {
  readonly id?: string;
  readonly agentId: string;
  readonly name?: string;
  readonly when: ScheduledTaskWhen;
  readonly runner: string;
  readonly runnerConfig: RunnerConfig;
  readonly payload?: Record<string, unknown>;
  readonly createdBy: ScheduledTaskCreatedBy;
  readonly createdByTraceId?: string;
  readonly ttl?: number;
  readonly maxRuns?: number;
  readonly traceId?: string;
  readonly reason?: ScheduledTaskCreatedReason;
}

/**
 * Caps applied to agent-created upserts (SPE-2049). The two caps protect
 * different failure modes:
 *
 *   - `maxPerTrace` is a runaway-loop guard: an agent run that decides
 *     to call `schedule_task()` in a loop hits the ceiling instead of
 *     filling Redis. The counter is the size of the per-trace index set,
 *     so it survives a Clawndom restart that lands mid-run — an
 *     in-process counter would reset to zero and let the loop continue.
 *   - `maxFutureWindowMs` is an "is this fireAt sane?" guard: agents
 *     can't accidentally (or maliciously) schedule for the year 3000.
 *
 * Both caps fire only when the input is `createdBy:'agent'`. Static
 * config-loaded tasks bypass the checks — operators control those
 * directly through `clawndom.yaml` and don't need a runtime gate.
 */
export interface ScheduledTaskCaps {
  readonly maxPerTrace: number;
  readonly maxFutureWindowMs: number;
}

export interface ScheduledTasksDependencies {
  readonly redis: IORedis;
  readonly eventBus: EventBus;
  /** Resolves the BullMQ Queue used to schedule firings for an agent. */
  readonly getQueue: (agentName: string) => Queue;
  /** Override for `Date.now()` in tests. */
  readonly now?: () => number;
  /**
   * Resolves a recurring task's next-fire wall-clock from its cron pattern
   * and timezone. Tests inject a deterministic stub; production wraps
   * `cron-parser` (declared as a direct dependency).
   */
  readonly nextFireFromCron?: (
    cron: string,
    timezone: string | undefined,
    fromMs: number,
  ) => number;
  /**
   * Per-trace and future-window caps. Resolved once at construction; the
   * production `getScheduledTasksService()` wires them from `getSettings()`.
   * Tests inject explicit numbers so the limits aren't sensitive to env.
   */
  readonly caps?: ScheduledTaskCaps;
}

/**
 * Thrown when an agent-created upsert would exceed a cap. The
 * controller maps these to HTTP responses: `per-trace` → 429,
 * `future-window` → 422. The fields are surfaced verbatim to the
 * caller so a Python client can read `cap`/`limit`/`observed` without
 * parsing the message.
 */
export class CapExceededError extends Error {
  constructor(
    public readonly cap: 'per-trace' | 'future-window',
    public readonly limit: number,
    public readonly observed: number,
  ) {
    super(
      cap === 'per-trace'
        ? `Per-trace scheduled-task cap exceeded (limit=${limit}, observed=${observed})`
        : `fireAt is more than ${limit} ms in the future (observed=${observed})`,
    );
    this.name = 'CapExceededError';
  }
}

/**
 * Redis-backed registry over `ScheduledTask` records. Adapter pattern
 * around BullMQ's queue API for the side-effects (`upsertJobScheduler`,
 * `add`, `removeJobScheduler`); the registry stays the only knowledge
 * layer for ownership / provenance / policy.
 *
 * Per design.md Decision 2: BullMQ owns timing, Redis owns durable state.
 * The `by-next-fire` sorted set is a read-side optimization for "what's
 * coming up" queries — never the firing trigger.
 *
 * Single-process today, multi-process safe by design — every read goes
 * through Redis so a future scale-out can register more workers without
 * touching this module.
 */
export class ScheduledTasksService {
  constructor(private readonly deps: ScheduledTasksDependencies) {}

  /**
   * Idempotent insert. If a record with this id already exists, the
   * payload is overwritten in place but no `scheduled-task.created` event
   * fires — config reload of an unchanged rule is a no-op.
   *
   * Returns the persisted task, including the resolved `nextFireAt` (the
   * caller's `when` may not have one for cron tasks until we ask cron-parser).
   */
  async upsert(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    const id = input.id ?? this.makeAgentTaskId(input);
    const now = this.now();
    const existing = await this.getById(id);

    // Caps gate agent-created tasks only. Existing records bypass the
    // gate so an in-place payload edit (re-upsert with the same id)
    // doesn't fail spuriously when the per-trace count is already at
    // the limit.
    if (input.createdBy === 'agent' && !existing) {
      await this.enforceCaps(input, now);
    }

    const nextFireAt = this.computeNextFire(input.when, now);
    const task: ScheduledTask = scheduledTaskSchema.parse({
      id,
      agentId: input.agentId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      when: input.when,
      runner: input.runner,
      runnerConfig: input.runnerConfig,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      createdBy: input.createdBy,
      ...(input.createdByTraceId !== undefined ? { createdByTraceId: input.createdByTraceId } : {}),
      ...(input.ttl !== undefined ? { ttl: input.ttl } : {}),
      ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
      runCount: existing?.runCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      ...(nextFireAt !== undefined ? { nextFireAt } : {}),
    });

    await this.persist(task);
    await this.scheduleInBullmq(task);

    if (!existing) {
      this.publishCreated(
        task,
        input.reason ?? this.defaultCreatedReason(input.createdBy),
        input.traceId,
      );
    }

    return task;
  }

  async getById(id: string): Promise<ScheduledTask | undefined> {
    const raw = await this.deps.redis.get(this.recordKey(id));
    if (raw === null) return undefined;
    try {
      return scheduledTaskSchema.parse(JSON.parse(raw));
    } catch (error) {
      logger.error({ id, error: serializeError(error) }, 'Failed to parse stored scheduled task');
      return undefined;
    }
  }

  /**
   * List with optional filters and cursor pagination. The cursor encodes
   * a numeric offset into the global by-next-fire sorted set; when filters
   * are present, the offset is into the filter intersection. The cursor
   * shape is opaque to clients — never parse it server-side, only pass
   * what was returned.
   */
  async list(
    filters: ScheduledTaskListFilters = {},
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ScheduledTaskListPage> {
    const limit = clampLimit(options.limit);
    const offset = decodeCursor(options.cursor);

    const ids = await this.collectFilteredIds(filters);
    const slice = ids.slice(offset, offset + limit);
    const tasks = await this.loadMany(slice);

    const nextOffset = offset + slice.length;
    const nextCursor = nextOffset < ids.length ? encodeCursor(nextOffset) : null;

    return { tasks, nextCursor };
  }

  /**
   * Remove a task. Idempotent: a missing id is a silent no-op (no event,
   * no error). Successful removals fire `scheduled-task.cancelled` with
   * the supplied reason.
   */
  async delete(
    id: string,
    options: { reason: ScheduledTaskCancelledReason; traceId?: string },
  ): Promise<{ removed: boolean }> {
    const existing = await this.getById(id);
    if (!existing) return { removed: false };

    await this.removeFromBullmq(existing);
    await this.removeFromRedis(existing);

    this.deps.eventBus.publish({
      type: 'scheduled-task.cancelled',
      timestamp: this.now(),
      traceId: options.traceId ?? `scheduled-task-${id}`,
      taskId: id,
      agentId: existing.agentId,
      runner: existing.runner,
      reason: options.reason,
    });

    return { removed: true };
  }

  /**
   * Fire-time hook. Called once per BullMQ pickup of a scheduled job.
   * Increments `runCount`, recomputes `nextFireAt` for cron tasks, and
   * checks ttl/maxRuns. If the task has expired, the registry cleans
   * the record + emits `scheduled-task.expired` and returns
   * `{ shouldFire: false }`. Otherwise emits `scheduled-task.fired` and
   * returns `{ shouldFire: true }`.
   */
  async recordFire(input: { id: string; jobId: string; traceId?: string }): Promise<{
    shouldFire: boolean;
    expiredReason?: ScheduledTaskExpiredReason;
  }> {
    const existing = await this.getById(input.id);
    if (!existing) return { shouldFire: false };

    const now = this.now();
    const expiredReason = this.checkExpired(existing, now);
    if (expiredReason) {
      await this.removeFromBullmq(existing);
      await this.removeFromRedis(existing);
      this.deps.eventBus.publish({
        type: 'scheduled-task.expired',
        timestamp: now,
        traceId: input.traceId ?? `scheduled-task-${input.id}`,
        taskId: existing.id,
        agentId: existing.agentId,
        runner: existing.runner,
        reason: expiredReason,
      });
      return { shouldFire: false, expiredReason };
    }

    const updated: ScheduledTask = {
      ...existing,
      runCount: existing.runCount + 1,
    };
    if (isCronWhen(existing.when)) {
      const nextFireAt = this.computeNextFire(existing.when, now);
      if (nextFireAt !== undefined) {
        updated.nextFireAt = nextFireAt;
      } else {
        delete updated.nextFireAt;
      }
    } else {
      // One-shot fired — drop the record after emission below.
      delete updated.nextFireAt;
    }

    if (isFireAtWhen(existing.when)) {
      // One-shot: removing here leaves the registry consistent before the
      // worker invokes the runner. BullMQ removes the delayed job
      // automatically on completion.
      await this.removeFromRedis(existing);
    } else {
      await this.persist(updated);
    }

    this.deps.eventBus.publish({
      type: 'scheduled-task.fired',
      timestamp: now,
      traceId: input.traceId ?? `scheduled-task-${input.id}`,
      taskId: existing.id,
      agentId: existing.agentId,
      runner: existing.runner,
      jobId: input.jobId,
    });
    return { shouldFire: true };
  }

  /**
   * Reconcile pass for config-load. Given the set of task ids the config
   * just produced, delete any `createdBy=config` records whose ids are
   * not in that set. Agent-created records are never touched.
   */
  async reconcileConfig(loadedIds: ReadonlySet<string>): Promise<readonly string[]> {
    const allConfigIds = await this.deps.redis.smembers(this.createdByKey('config'));
    const orphans = allConfigIds.filter((id) => !loadedIds.has(id));
    for (const id of orphans) {
      await this.delete(id, { reason: 'config-reconcile' });
    }
    return orphans;
  }

  /**
   * Visible-for-testing helper: drop every key under the registry's
   * prefix. Production code should never call this — it exists so tests
   * can isolate runs against a shared Redis instance without coordinating
   * key namespaces.
   */
  async clearForTests(): Promise<void> {
    const keys = await this.deps.redis.keys(`${KEY_PREFIX}:*`);
    if (keys.length === 0) return;
    await this.deps.redis.del(...keys);
  }

  // -------------------------------------------------------------------
  // Internal — persistence
  // -------------------------------------------------------------------

  private async persist(task: ScheduledTask): Promise<void> {
    const json = JSON.stringify(task);
    const multi = this.deps.redis.multi();
    multi.set(this.recordKey(task.id), json);
    multi.sadd(ALL_IDS_KEY, task.id);
    multi.sadd(this.createdByKey(task.createdBy), task.id);
    multi.sadd(this.agentKey(task.agentId), task.id);
    if (task.createdByTraceId) {
      multi.sadd(this.traceKey(task.createdByTraceId), task.id);
    }
    if (task.nextFireAt !== undefined) {
      multi.zadd(NEXT_FIRE_KEY, task.nextFireAt, task.id);
    } else {
      multi.zrem(NEXT_FIRE_KEY, task.id);
    }
    await multi.exec();
  }

  private async removeFromRedis(task: ScheduledTask): Promise<void> {
    const multi = this.deps.redis.multi();
    multi.del(this.recordKey(task.id));
    multi.srem(ALL_IDS_KEY, task.id);
    multi.srem(this.createdByKey(task.createdBy), task.id);
    multi.srem(this.agentKey(task.agentId), task.id);
    if (task.createdByTraceId) {
      multi.srem(this.traceKey(task.createdByTraceId), task.id);
    }
    multi.zrem(NEXT_FIRE_KEY, task.id);
    await multi.exec();
  }

  private async loadMany(ids: readonly string[]): Promise<readonly ScheduledTask[]> {
    if (ids.length === 0) return [];
    const keys = ids.map((id) => this.recordKey(id));
    const raws = await this.deps.redis.mget(...keys);
    const tasks: ScheduledTask[] = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = raws[i];
      if (raw === null || raw === undefined) continue;
      try {
        tasks.push(scheduledTaskSchema.parse(JSON.parse(raw)));
      } catch (error) {
        logger.error(
          { id: ids[i], error: serializeError(error) },
          'Failed to parse stored scheduled task during list',
        );
      }
    }
    return tasks;
  }

  // -------------------------------------------------------------------
  // Internal — filter resolution
  // -------------------------------------------------------------------

  /**
   * Build the ordered id list that satisfies all active filters. Returns
   * ids in `nextFireAt` ascending order — the firing-soonest first —
   * which is the natural sort for the dashboard's "what's coming up"
   * view. Records without `nextFireAt` (cron tasks pre-first-fire on
   * older clients, plus paused) sort to the end.
   */
  private async collectFilteredIds(filters: ScheduledTaskListFilters): Promise<readonly string[]> {
    const filterKeys = this.activeFilterKeys(filters);
    const candidate =
      filterKeys.length > 0 ? new Set(await this.intersectFilters(filterKeys)) : null;

    const orderedByFire = await this.deps.redis.zrange(NEXT_FIRE_KEY, 0, -1);
    const all = await this.deps.redis.smembers(ALL_IDS_KEY);
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const id of orderedByFire) {
      if (candidate && !candidate.has(id)) continue;
      ordered.push(id);
      seen.add(id);
    }
    for (const id of all) {
      if (seen.has(id)) continue;
      if (candidate && !candidate.has(id)) continue;
      ordered.push(id);
    }
    return ordered;
  }

  private activeFilterKeys(filters: ScheduledTaskListFilters): readonly string[] {
    const keys: string[] = [];
    if (filters.createdBy) keys.push(this.createdByKey(filters.createdBy));
    if (filters.agentId) keys.push(this.agentKey(filters.agentId));
    if (filters.createdByTraceId) keys.push(this.traceKey(filters.createdByTraceId));
    return keys;
  }

  /**
   * Intersect filter index sets. With one key the answer is the set
   * itself; with multiple keys we compute and discard a temp key under
   * `Date.now()` salt — short-lived but namespaced so concurrent calls
   * never clobber each other.
   */
  private async intersectFilters(keys: readonly string[]): Promise<string[]> {
    if (keys.length === 1) {
      return this.deps.redis.smembers(keys[0]!);
    }
    const temporaryKey = `${KEY_PREFIX}:tmp:list:${this.now()}:${randomBytes(4).toString('hex')}`;
    try {
      await this.deps.redis.sinterstore(temporaryKey, ...keys);
      return await this.deps.redis.smembers(temporaryKey);
    } finally {
      await this.deps.redis.del(temporaryKey).catch(() => {});
    }
  }

  // -------------------------------------------------------------------
  // Internal — BullMQ adapter
  // -------------------------------------------------------------------

  private async scheduleInBullmq(task: ScheduledTask): Promise<void> {
    const queue = this.deps.getQueue(task.agentId);
    const data = JSON.stringify({
      kind: 'scheduled' as const,
      taskId: task.id,
      rule: task.name ?? task.id,
      context: task.payload ?? {},
    });
    if (isCronWhen(task.when)) {
      const repeatOpts = task.when.timezone
        ? { pattern: task.when.cron, tz: task.when.timezone }
        : { pattern: task.when.cron };
      await queue.upsertJobScheduler(this.bullmqSchedulerId(task), repeatOpts, {
        name: task.name ?? task.id,
        data,
        opts: {
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      });
    } else {
      const delay = Math.max(0, task.when.fireAt - this.now());
      // BullMQ rejects job ids containing a colon; the registry id is
      // already free of separator characters, but keep the wrap helper for
      // future-proofing.
      await queue.add(task.name ?? task.id, data, {
        delay,
        jobId: this.bullmqOneShotJobId(task),
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      });
    }
  }

  private async removeFromBullmq(task: ScheduledTask): Promise<void> {
    const queue = this.deps.getQueue(task.agentId);
    if (isCronWhen(task.when)) {
      await queue.removeJobScheduler(this.bullmqSchedulerId(task)).catch((error: unknown) => {
        logger.warn(
          { taskId: task.id, error: serializeError(error) },
          'removeJobScheduler failed; continuing with registry cleanup',
        );
      });
    } else {
      try {
        const job = await queue.getJob(this.bullmqOneShotJobId(task));
        if (job) await job.remove();
      } catch (error: unknown) {
        logger.warn(
          { taskId: task.id, error: serializeError(error) },
          'BullMQ one-shot removal failed; continuing with registry cleanup',
        );
      }
    }
  }

  // -------------------------------------------------------------------
  // Internal — small helpers
  // -------------------------------------------------------------------

  private bullmqSchedulerId(task: ScheduledTask): string {
    return `scheduled-task-${task.id}`;
  }

  private bullmqOneShotJobId(task: ScheduledTask): string {
    return `scheduled-task-${task.id}`;
  }

  private recordKey(id: string): string {
    return `${RECORD_KEY_PREFIX}:${id}`;
  }

  private createdByKey(createdBy: ScheduledTaskCreatedBy): string {
    return `${BY_CREATED_BY_PREFIX}:${createdBy}`;
  }

  private agentKey(agentId: string): string {
    return `${BY_AGENT_PREFIX}:${agentId}`;
  }

  private traceKey(traceId: string): string {
    return `${BY_TRACE_PREFIX}:${traceId}`;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Cap enforcement for agent-created upserts. The per-trace count uses
   * Redis SCARD against the existing `BY_TRACE_PREFIX` set so it stays
   * accurate across Clawndom restarts; the future-window check is a
   * pure now-vs-fireAt comparison and ignores cron tasks (they're
   * bounded by `maxRuns`/`ttl` instead).
   */
  private async enforceCaps(input: CreateScheduledTaskInput, now: number): Promise<void> {
    const caps = this.deps.caps;
    if (!caps) return;

    if (
      caps.maxPerTrace > 0 &&
      input.createdByTraceId !== undefined &&
      input.createdByTraceId.length > 0
    ) {
      const count = await this.deps.redis.scard(this.traceKey(input.createdByTraceId));
      if (count >= caps.maxPerTrace) {
        throw new CapExceededError('per-trace', caps.maxPerTrace, count);
      }
    }

    if (caps.maxFutureWindowMs > 0 && isFireAtWhen(input.when)) {
      const delta = input.when.fireAt - now;
      if (delta > caps.maxFutureWindowMs) {
        throw new CapExceededError('future-window', caps.maxFutureWindowMs, delta);
      }
    }
  }

  private checkExpired(task: ScheduledTask, now: number): ScheduledTaskExpiredReason | undefined {
    if (task.ttl !== undefined && now >= task.ttl) return 'ttl';
    if (task.maxRuns !== undefined && task.runCount >= task.maxRuns) return 'maxRuns';
    return undefined;
  }

  private computeNextFire(when: ScheduledTaskWhen, now: number): number | undefined {
    if (isFireAtWhen(when)) return when.fireAt;
    const resolver = this.deps.nextFireFromCron;
    if (!resolver) return undefined;
    try {
      return resolver(when.cron, when.timezone, now);
    } catch (error) {
      logger.warn(
        { cron: when.cron, error: serializeError(error) },
        'next-fire computation failed for cron task',
      );
      return undefined;
    }
  }

  private defaultCreatedReason(createdBy: ScheduledTaskCreatedBy): ScheduledTaskCreatedReason {
    return createdBy === 'config' ? 'config-load' : 'agent-create';
  }

  private publishCreated(
    task: ScheduledTask,
    reason: ScheduledTaskCreatedReason,
    traceId: string | undefined,
  ): void {
    this.deps.eventBus.publish({
      type: 'scheduled-task.created',
      timestamp: this.now(),
      traceId: traceId ?? task.createdByTraceId ?? `scheduled-task-${task.id}`,
      taskId: task.id,
      agentId: task.agentId,
      runner: task.runner,
      createdBy: task.createdBy,
      ...(task.createdByTraceId !== undefined ? { ownerTraceId: task.createdByTraceId } : {}),
      ...(task.nextFireAt !== undefined ? { nextFireAt: task.nextFireAt } : {}),
      reason,
    });
  }

  private makeAgentTaskId(input: CreateScheduledTaskInput): string {
    // Agent-created tasks get a random id — the registry doesn't need
    // content-hash idempotence for runtime creation. 16 hex chars matches
    // the config-task id width so dashboard rendering is uniform.
    const random = `${this.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    return `${input.agentId}-${random}`.replaceAll(/[^a-zA-Z0-9-]/g, '-').slice(0, 32);
  }
}

// ---------------------------------------------------------------------------
// Singleton wiring
// ---------------------------------------------------------------------------

let instance: ScheduledTasksService | null = null;
let dedicatedRedis: IORedis | null = null;

/**
 * Return the process-wide registry. Lazily constructs a dedicated Redis
 * connection on first call so the test setup file's `resetSettings()`
 * + ad-hoc construction patterns don't conflict with the BullMQ
 * connection pool in `task.service.ts`.
 */
export function getScheduledTasksService(): ScheduledTasksService {
  if (instance) return instance;
  const settings = getSettings();
  dedicatedRedis = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });
  instance = new ScheduledTasksService({
    redis: dedicatedRedis,
    eventBus: getEventBus(),
    getQueue: getTaskQueue,
    nextFireFromCron: resolveNextFireFromCron,
    caps: {
      maxPerTrace: settings.scheduledTasksMaxPerTrace,
      maxFutureWindowMs: settings.scheduledTasksMaxFutureWindowMs,
    },
  });
  return instance;
}

export function resetScheduledTasksService(): void {
  instance = null;
  if (dedicatedRedis) {
    dedicatedRedis.disconnect();
    dedicatedRedis = null;
  }
}

/**
 * Test-only injection point for swapping in a stub registry. Production
 * paths must use {@link getScheduledTasksService}.
 */
export function setScheduledTasksServiceForTests(stub: ScheduledTasksService): void {
  instance = stub;
}

/**
 * Default cron next-fire resolver. Lazy-loaded `cron-parser` keeps the
 * dependency invisible to consumers that don't need it (the registry's
 * unit tests inject their own resolver). `createRequire` works in our
 * ESM build where a top-level `import` of cron-parser would force the
 * dep into the cold path of every consumer of this module.
 */
const requireCronParser = createRequire(import.meta.url);

interface CronParserV5Module {
  CronExpressionParser: {
    parse: (
      expression: string,
      options: { currentDate: number; tz?: string },
    ) => { next: () => { getTime: () => number } };
  };
}

// Exported so the dependency contract — "this module resolves a usable
// `cron-parser`" — has a regression guard. The boot logs surfaced a
// missing-module warning when `cron-parser` was assumed transitive but
// no longer ships through BullMQ; the test below covers that gap.
export function resolveNextFireFromCron(
  cron: string,
  timezone: string | undefined,
  fromMs: number,
): number {
  const { CronExpressionParser } = requireCronParser('cron-parser') as CronParserV5Module;
  const interval = CronExpressionParser.parse(cron, {
    currentDate: fromMs,
    ...(timezone ? { tz: timezone } : {}),
  });
  return interval.next().getTime();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

// noqa: NAMING001
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf-8').toString('base64url');
}

// noqa: NAMING001
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as {
      o?: unknown;
    };
    if (typeof parsed.o !== 'number' || !Number.isFinite(parsed.o) || parsed.o < 0) return 0;
    return Math.floor(parsed.o);
  } catch {
    return 0;
  }
}

function serializeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Re-export the runner-config schema so the controller can build its
 * Zod-validated body schema without a separate import path. Keeps
 * "the registry's view of valid runner configs" as a single seam.
 */
export { runnerConfigSchema };
