import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type IORedis from 'ioredis';

import type { Queue } from 'bullmq';

import {
  CapExceededError,
  ScheduledTasksService,
  resolveNextFireFromCron,
} from '../../src/services/scheduled-tasks.service';
import type { CreateScheduledTaskInput } from '../../src/services/scheduled-tasks.service';
import { deriveConfigTaskId, stableStringify } from '../../src/types/scheduled-task';
import type { ClawndomEvent } from '../../src/types/clawndom-event';
import type { EventBus, StampedEvent } from '../../src/services/event-bus.service';

interface QueueStub {
  upsertJobScheduler: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  removeJobScheduler: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
}

interface MockJob {
  remove: ReturnType<typeof vi.fn>;
}

function buildQueueStub(): QueueStub {
  return {
    upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    removeJobScheduler: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn<(id: string) => Promise<MockJob | null>>().mockResolvedValue(null),
  };
}

interface RecordedEvent {
  type: ClawndomEvent['type'];
  event: ClawndomEvent;
}

function buildEventBusStub(): { bus: EventBus; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  const bus = {
    publish: (event: ClawndomEvent): StampedEvent => {
      events.push({ type: event.type, event });
      return { id: events.length, timestampMs: Date.now(), event };
    },
  } as unknown as EventBus;
  return { bus, events };
}

const FIXED_NOW = 1_700_000_000_000;

function makeBaseInput(
  overrides: Partial<CreateScheduledTaskInput> = {},
): CreateScheduledTaskInput {
  return {
    agentId: 'patch',
    name: 'daily-handoff',
    when: { cron: '45 7 * * 1-5', timezone: 'America/New_York' },
    runner: 'claude-cli',
    runnerConfig: { type: 'claude-cli', workDirectory: '/agents/patch' },
    createdBy: 'config',
    ...overrides,
  };
}

describe('ScheduledTasksService', () => {
  let redis: IORedis;
  let queues: Map<string, QueueStub>;
  let events: RecordedEvent[];
  let bus: EventBus;
  let service: ScheduledTasksService;

  beforeEach(() => {
    redis = new RedisMock() as unknown as IORedis;
    queues = new Map();
    const eventStub = buildEventBusStub();
    events = eventStub.events;
    bus = eventStub.bus;
    service = new ScheduledTasksService({
      redis,
      eventBus: bus,
      // Returning a structural stub typed as Queue keeps the test file
      // honest with the production seam without dragging in BullMQ's
      // full surface (jobs API, events, etc.). We only assert against
      // the four methods the registry actually calls.
      getQueue: (agentName: string): Queue => {
        let queue = queues.get(agentName);
        if (!queue) {
          queue = buildQueueStub();
          queues.set(agentName, queue);
        }
        return queue as unknown as Queue;
      },
      now: (): number => FIXED_NOW,
      nextFireFromCron: (_cron, _tz, fromMs): number => fromMs + 60_000,
    });
  });

  afterEach(async () => {
    await redis.flushall();
    await redis.quit();
  });

  describe('content-hash id derivation', () => {
    it('produces identical ids for identical config (key-order independent)', () => {
      const id1 = deriveConfigTaskId({
        agentId: 'patch',
        name: 'daily',
        when: { cron: '0 9 * * *', timezone: 'UTC' },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/x' },
      });
      const id2 = deriveConfigTaskId({
        agentId: 'patch',
        name: 'daily',
        runner: 'claude-cli',
        when: { timezone: 'UTC', cron: '0 9 * * *' },
        runnerConfig: { workDirectory: '/x', type: 'claude-cli' },
      });
      expect(id1).toBe(id2);
      expect(id1).toHaveLength(16);
    });

    it('produces different ids when any field changes', () => {
      const base = {
        agentId: 'patch',
        name: 'daily',
        when: { cron: '0 9 * * *' },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli' as const, workDirectory: '/x' },
      };
      const baseId = deriveConfigTaskId(base);
      expect(deriveConfigTaskId({ ...base, agentId: 'scarlett' })).not.toBe(baseId);
      expect(deriveConfigTaskId({ ...base, name: 'morning' })).not.toBe(baseId);
      expect(deriveConfigTaskId({ ...base, when: { cron: '0 10 * * *' } })).not.toBe(baseId);
      expect(
        deriveConfigTaskId({
          ...base,
          runnerConfig: { type: 'claude-cli', workDirectory: '/y' },
        }),
      ).not.toBe(baseId);
    });
  });

  describe('upsert', () => {
    it('persists a task and emits scheduled-task.created on first insert', async () => {
      const task = await service.upsert(makeBaseInput({ id: 'task-abc' }));

      expect(task.id).toBe('task-abc');
      expect(task.runCount).toBe(0);
      expect(task.createdAt).toBe(FIXED_NOW);
      expect(task.nextFireAt).toBe(FIXED_NOW + 60_000);

      expect(events.map((e) => e.type)).toEqual(['scheduled-task.created']);
      const created = events[0]!.event;
      if (created.type !== 'scheduled-task.created') throw new Error('wrong event type');
      expect(created).toMatchObject({
        taskId: 'task-abc',
        agentId: 'patch',
        runner: 'claude-cli',
        createdBy: 'config',
        reason: 'config-load',
      });
    });

    it('is idempotent: re-upserting the same id does not re-emit created', async () => {
      await service.upsert(makeBaseInput({ id: 'task-1' }));
      await service.upsert(makeBaseInput({ id: 'task-1' }));
      const createdEvents = events.filter((e) => e.type === 'scheduled-task.created');
      expect(createdEvents).toHaveLength(1);
    });

    it('preserves runCount and createdAt across upserts', async () => {
      const original = await service.upsert(makeBaseInput({ id: 'task-2' }));
      // Simulate a fire — runCount goes to 1 — then re-upsert.
      await service.recordFire({ id: 'task-2', jobId: 'j1' });
      const reupserted = await service.upsert(makeBaseInput({ id: 'task-2' }));
      expect(reupserted.createdAt).toBe(original.createdAt);
      expect(reupserted.runCount).toBe(1);
    });

    it('schedules a cron task via upsertJobScheduler', async () => {
      await service.upsert(makeBaseInput({ id: 'cron-1' }));
      const queue = queues.get('patch')!;
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        'scheduled-task-cron-1',
        { pattern: '45 7 * * 1-5', tz: 'America/New_York' },
        expect.objectContaining({ name: 'daily-handoff' }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('schedules a one-shot task via queue.add with a delay', async () => {
      await service.upsert(
        makeBaseInput({
          id: 'oneshot-1',
          when: { fireAt: FIXED_NOW + 10_000 },
          name: 'one-shot',
        }),
      );
      const queue = queues.get('patch')!;
      expect(queue.add).toHaveBeenCalledWith(
        'one-shot',
        expect.any(String),
        expect.objectContaining({
          delay: 10_000,
          jobId: 'scheduled-task-oneshot-1',
        }),
      );
      expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await service.upsert(
        makeBaseInput({
          id: 't1',
          agentId: 'patch',
          when: { fireAt: FIXED_NOW + 1_000 },
          name: 't1',
        }),
      );
      await service.upsert(
        makeBaseInput({
          id: 't2',
          agentId: 'patch',
          when: { fireAt: FIXED_NOW + 2_000 },
          name: 't2',
        }),
      );
      await service.upsert(
        makeBaseInput({
          id: 't3',
          agentId: 'scarlett',
          when: { fireAt: FIXED_NOW + 3_000 },
          name: 't3',
          createdBy: 'agent',
          createdByTraceId: 'trace-99',
        }),
      );
    });

    it('returns all tasks ordered by nextFireAt ascending', async () => {
      const page = await service.list();
      expect(page.tasks.map((task) => task.id)).toEqual(['t1', 't2', 't3']);
      expect(page.nextCursor).toBeNull();
    });

    it('filters by createdBy', async () => {
      const page = await service.list({ createdBy: 'agent' });
      expect(page.tasks.map((task) => task.id)).toEqual(['t3']);
    });

    it('filters by agentId', async () => {
      const page = await service.list({ agentId: 'patch' });
      expect(page.tasks.map((task) => task.id)).toEqual(['t1', 't2']);
    });

    it('filters by createdByTraceId', async () => {
      const page = await service.list({ createdByTraceId: 'trace-99' });
      expect(page.tasks.map((task) => task.id)).toEqual(['t3']);
    });

    it('intersects multiple filters', async () => {
      const page = await service.list({ createdBy: 'agent', agentId: 'patch' });
      expect(page.tasks).toEqual([]);
    });

    it('paginates via opaque cursor', async () => {
      const first = await service.list({}, { limit: 2 });
      expect(first.tasks.map((task) => task.id)).toEqual(['t1', 't2']);
      expect(first.nextCursor).not.toBeNull();

      const second = await service.list({}, { limit: 2, cursor: first.nextCursor! });
      expect(second.tasks.map((task) => task.id)).toEqual(['t3']);
      expect(second.nextCursor).toBeNull();
    });

    it('treats malformed cursor as offset 0', async () => {
      const page = await service.list({}, { cursor: '!!!not-base64!!!', limit: 1 });
      expect(page.tasks.map((task) => task.id)).toEqual(['t1']);
    });
  });

  describe('delete', () => {
    it('removes the record, drops indices, and emits cancelled', async () => {
      await service.upsert(makeBaseInput({ id: 'del-1' }));
      events.length = 0;

      const result = await service.delete('del-1', { reason: 'api-delete' });

      expect(result.removed).toBe(true);
      expect(await service.getById('del-1')).toBeUndefined();
      expect(events.map((e) => e.type)).toEqual(['scheduled-task.cancelled']);
      const cancelled = events[0]!.event;
      if (cancelled.type !== 'scheduled-task.cancelled') throw new Error('wrong event');
      expect(cancelled.reason).toBe('api-delete');
    });

    it('is idempotent: deleting an unknown id is a silent no-op', async () => {
      const result = await service.delete('does-not-exist', { reason: 'api-delete' });
      expect(result.removed).toBe(false);
      expect(events).toEqual([]);
    });
  });

  describe('recordFire', () => {
    it('emits scheduled-task.fired and increments runCount on a healthy fire', async () => {
      await service.upsert(makeBaseInput({ id: 'fire-1' }));
      events.length = 0;

      const decision = await service.recordFire({ id: 'fire-1', jobId: 'bull-job-7' });

      expect(decision.shouldFire).toBe(true);
      const updated = await service.getById('fire-1');
      expect(updated?.runCount).toBe(1);
      expect(events.map((e) => e.type)).toEqual(['scheduled-task.fired']);
      const fired = events[0]!.event;
      if (fired.type !== 'scheduled-task.fired') throw new Error('wrong event');
      expect(fired.jobId).toBe('bull-job-7');
    });

    it('removes the record on one-shot fire (fireAt)', async () => {
      await service.upsert(
        makeBaseInput({
          id: 'one-1',
          when: { fireAt: FIXED_NOW + 10_000 },
          name: 'one-1',
        }),
      );
      const decision = await service.recordFire({ id: 'one-1', jobId: 'b1' });
      expect(decision.shouldFire).toBe(true);
      expect(await service.getById('one-1')).toBeUndefined();
    });

    it('expires by ttl and emits scheduled-task.expired', async () => {
      await service.upsert(makeBaseInput({ id: 'ttl-1', ttl: FIXED_NOW - 1 }));
      events.length = 0;
      const decision = await service.recordFire({ id: 'ttl-1', jobId: 'b1' });
      expect(decision).toEqual({ shouldFire: false, expiredReason: 'ttl' });
      expect(events.map((e) => e.type)).toEqual(['scheduled-task.expired']);
      expect(await service.getById('ttl-1')).toBeUndefined();
    });

    it('expires by maxRuns and emits scheduled-task.expired', async () => {
      await service.upsert(makeBaseInput({ id: 'max-1', maxRuns: 1 }));
      // First fire succeeds.
      await service.recordFire({ id: 'max-1', jobId: 'b1' });
      events.length = 0;
      // Second fire trips maxRuns.
      const decision = await service.recordFire({ id: 'max-1', jobId: 'b2' });
      expect(decision).toEqual({ shouldFire: false, expiredReason: 'maxRuns' });
      expect(events.map((e) => e.type)).toEqual(['scheduled-task.expired']);
    });

    it('returns shouldFire=false when the id is unknown', async () => {
      const decision = await service.recordFire({ id: 'phantom', jobId: 'b1' });
      expect(decision).toEqual({ shouldFire: false });
    });
  });

  describe('reconcileConfig', () => {
    it('removes config-created tasks not in the loaded set', async () => {
      await service.upsert(makeBaseInput({ id: 'cfg-1', createdBy: 'config' }));
      await service.upsert(makeBaseInput({ id: 'cfg-2', createdBy: 'config', name: 'cfg-2' }));
      await service.upsert(makeBaseInput({ id: 'agent-1', createdBy: 'agent', name: 'agent-1' }));

      const orphans = await service.reconcileConfig(new Set(['cfg-1']));

      expect(orphans).toEqual(['cfg-2']);
      expect(await service.getById('cfg-1')).toBeDefined();
      expect(await service.getById('cfg-2')).toBeUndefined();
      expect(await service.getById('agent-1')).toBeDefined();
    });

    it('never deletes agent-created tasks', async () => {
      await service.upsert(makeBaseInput({ id: 'a-1', createdBy: 'agent', name: 'a-1' }));
      const orphans = await service.reconcileConfig(new Set());
      expect(orphans).toEqual([]);
      expect(await service.getById('a-1')).toBeDefined();
    });
  });

  describe('stableStringify', () => {
    it('sorts keys deterministically across reorderings', () => {
      const a = stableStringify({ b: 2, a: 1, c: { z: 1, y: 2 } });
      const b = stableStringify({ a: 1, c: { y: 2, z: 1 }, b: 2 });
      expect(a).toBe(b);
    });
  });

  // SPE-2049: caps are the registry's only line of defence against an
  // agent run that loops on schedule_task(). Without these, a single
  // misbehaving template could fill Redis or queue a fireAt for the
  // year 3000 and starve the registry pruner.
  describe('agent-created caps (SPE-2049)', () => {
    function makeAgentInput(
      overrides: Partial<CreateScheduledTaskInput> = {},
    ): CreateScheduledTaskInput {
      return {
        agentId: 'patch',
        when: { fireAt: FIXED_NOW + 60_000 },
        runner: 'claude-cli',
        runnerConfig: { type: 'claude-cli', workDirectory: '/agents/patch' },
        createdBy: 'agent',
        createdByTraceId: 'trace-A',
        ...overrides,
      };
    }

    function buildCappedService(caps: {
      maxPerTrace: number;
      maxFutureWindowMs: number;
    }): ScheduledTasksService {
      return new ScheduledTasksService({
        redis,
        eventBus: bus,
        getQueue: (agentName: string): Queue => {
          let queue = queues.get(agentName);
          if (!queue) {
            queue = buildQueueStub();
            queues.set(agentName, queue);
          }
          return queue as unknown as Queue;
        },
        now: (): number => FIXED_NOW,
        nextFireFromCron: (_cron, _tz, fromMs): number => fromMs + 60_000,
        caps,
      });
    }

    it('allows agent upserts up to the per-trace ceiling', async () => {
      const cappedService = buildCappedService({
        maxPerTrace: 3,
        maxFutureWindowMs: Number.MAX_SAFE_INTEGER,
      });
      for (let i = 0; i < 3; i++) {
        await cappedService.upsert(makeAgentInput({ when: { fireAt: FIXED_NOW + 60_000 + i } }));
      }
      const fourth = cappedService.upsert(
        makeAgentInput({ when: { fireAt: FIXED_NOW + 60_000 + 99 } }),
      );
      await expect(fourth).rejects.toBeInstanceOf(CapExceededError);
      await expect(fourth).rejects.toMatchObject({ cap: 'per-trace', limit: 3 });
    });

    it('rejects agent upserts whose fireAt is past the future-window cap', async () => {
      const cappedService = buildCappedService({
        maxPerTrace: 100,
        maxFutureWindowMs: 60_000, // 1 minute window
      });
      // 2 minutes ahead — beyond the cap.
      const tooFar = cappedService.upsert(
        makeAgentInput({ when: { fireAt: FIXED_NOW + 2 * 60_000 } }),
      );
      await expect(tooFar).rejects.toBeInstanceOf(CapExceededError);
      await expect(tooFar).rejects.toMatchObject({ cap: 'future-window', limit: 60_000 });
    });

    it('does not apply caps to config-loaded tasks', async () => {
      const cappedService = buildCappedService({
        maxPerTrace: 1,
        maxFutureWindowMs: 1, // 1ms window — would block any agent task
      });
      // Static config-load: cron schedule, no traceId, way past the
      // future-window cap if it applied.
      await expect(
        cappedService.upsert({
          id: 'config-1',
          agentId: 'patch',
          name: 'daily',
          when: { cron: '0 9 * * *', timezone: 'UTC' },
          runner: 'claude-cli',
          runnerConfig: { type: 'claude-cli', workDirectory: '/agents/patch' },
          createdBy: 'config',
        }),
      ).resolves.toBeDefined();
    });

    it('lets a re-upsert of an existing agent task bypass the per-trace cap', async () => {
      const cappedService = buildCappedService({
        maxPerTrace: 1,
        maxFutureWindowMs: Number.MAX_SAFE_INTEGER,
      });
      const created = await cappedService.upsert(
        makeAgentInput({ id: 'task-A', when: { fireAt: FIXED_NOW + 60_000 } }),
      );
      // Same id — caps should NOT trip just because the trace already
      // owns one task. This is the "edit in place" path.
      await expect(
        cappedService.upsert(
          makeAgentInput({ id: created.id, when: { fireAt: FIXED_NOW + 60_001 } }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('resolveNextFireFromCron — real `cron-parser` integration', () => {
    // Regression guard for the boot warning "Cannot find module 'cron-parser'"
    // surfaced during the SPE-2078 EC2 deploy: BullMQ's transitive copy went
    // away, so cron-parser is now a direct dependency. This test exercises the
    // real module — no stub — so a removed/broken-API upgrade fails CI before
    // it pollutes operator logs.
    it('computes the next fire time for a weekday-only cron in NY time', () => {
      // Sun 2026-05-10 00:00:00 UTC — next 6:00 AM ET weekday is Mon 2026-05-11.
      const fromMs = Date.UTC(2026, 4, 10, 0, 0, 0);
      const next = resolveNextFireFromCron('0 6 * * 1-5', 'America/New_York', fromMs);
      const expected = Date.UTC(2026, 4, 11, 10, 0, 0); // 6 AM ET = 10 AM UTC (EDT)
      expect(next).toBe(expected);
    });

    it('returns a strictly-future fire time when no timezone is supplied', () => {
      // cron-parser v5 defaults to the host process's local TZ when `tz`
      // is omitted; nailing down a specific epoch ms would make this test
      // flaky on CI vs. dev. Asserting strict-monotonic + 1-day window is
      // enough to confirm the parser handed back a valid Date.
      const fromMs = Date.UTC(2026, 4, 10, 0, 0, 0);
      const next = resolveNextFireFromCron('0 12 * * *', undefined, fromMs);
      expect(next).toBeGreaterThan(fromMs);
      expect(next - fromMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });
  });
});
