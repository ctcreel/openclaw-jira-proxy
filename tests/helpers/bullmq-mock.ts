/**
 * Shared BullMQ test double.
 *
 * Replaces the per-test `vi.mock('bullmq', ...)` blocks that drifted into
 * five near-duplicates across `queue.service.test.ts`, `task.service.test.ts`,
 * `orphan-reaper.service.test.ts`, `scheduler.service.test.ts`, and
 * `worker.service.test.ts`. None of those mocks called the colon-rejection
 * that real BullMQ enforces at runtime, which is why SPE-1824 and SPE-1999
 * shipped to production through CI green.
 *
 * Every Queue/Worker/QueueEvents constructor here calls
 * `assertBullmqSafeName(name)` so a future bad name fails at the unit-test
 * layer the same way it fails at runtime — no per-site static asserts
 * required.
 *
 * Usage in a test file:
 *
 * ```ts
 * import { bullmqMockModule, bullmqMockState } from '../helpers/bullmq-mock';
 *
 * vi.mock('bullmq', async () => {
 *   const helper = await import('../helpers/bullmq-mock');
 *   return helper.bullmqMockModule;
 * });
 *
 * beforeEach(() => bullmqMockState.reset());
 * ```
 *
 * State inspection: read per-instance fields (`queue.addCalls`,
 * `queue.upsertJobSchedulerCalls`, `queue.jobs`) directly, or use the
 * registry helpers (`bullmqMockState.queueInstances`, `findQueueByName`)
 * for cases where the test has no handle on the production-side getter.
 */

import { assertBullmqSafeName } from '../../src/lib/bullmq-name';

export interface BullmqMockJob {
  id: string;
  data: unknown;
  state: string;
  returnvalue?: unknown;
  failedReason?: string;
}

export interface BullmqAddCall {
  name: string;
  data: unknown;
  opts?: ({ jobId?: string } & Record<string, unknown>) | undefined;
}

export interface BullmqUpsertSchedulerCall {
  id: string;
  opts: unknown;
  template: unknown;
}

interface BullmqJobHandle {
  id: string;
  data: unknown;
  readonly returnvalue: unknown;
  readonly failedReason: string | undefined;
  getState(): Promise<string>;
  waitUntilFinished(): Promise<unknown>;
}

export class BullmqQueueMock {
  public readonly name: string;
  public readonly addCalls: BullmqAddCall[] = [];
  public readonly upsertJobSchedulerCalls: BullmqUpsertSchedulerCall[] = [];
  public readonly jobs = new Map<string, BullmqMockJob>();
  public closed = false;

  constructor(name: string, _opts?: unknown) {
    assertBullmqSafeName(name);
    this.name = name;
    bullmqMockState.queueInstances.push(this);
  }

  async add(
    name: string,
    data: unknown,
    opts?: ({ jobId?: string } & Record<string, unknown>) | undefined,
  ): Promise<{ id: string }> {
    this.addCalls.push({ name, data, opts });
    const id = opts?.jobId ?? `auto-${this.addCalls.length}`;
    this.jobs.set(id, { id, data, state: 'waiting' });
    return { id };
  }

  async getJob(id: string): Promise<BullmqJobHandle | undefined> {
    const raw = this.jobs.get(id);
    if (!raw) return undefined;
    // The handle reads `returnvalue` / `failedReason` lazily so tests can
    // mutate the underlying job state via the `jobs` map between
    // `getJob()` and the assertion.
    return {
      id,
      data: raw.data,
      get returnvalue(): unknown {
        return raw.returnvalue;
      },
      get failedReason(): string | undefined {
        return raw.failedReason;
      },
      async getState(): Promise<string> {
        return raw.state;
      },
      async waitUntilFinished(): Promise<unknown> {
        return raw.returnvalue;
      },
    };
  }

  async upsertJobScheduler(id: string, opts: unknown, template: unknown): Promise<void> {
    this.upsertJobSchedulerCalls.push({ id, opts, template });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

type WorkerProcessor = (...args: unknown[]) => unknown;

export class BullmqWorkerMock {
  public readonly name: string;
  public readonly listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  public closed = false;

  constructor(name: string, _processor?: WorkerProcessor, _opts?: unknown) {
    assertBullmqSafeName(name);
    this.name = name;
    bullmqMockState.workerInstances.push(this);
  }

  on(event: string, fn: (...args: unknown[]) => void): this {
    this.listeners.push({ event, fn });
    return this;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class BullmqQueueEventsMock {
  public readonly name: string;
  public closed = false;

  constructor(name: string, _opts?: unknown) {
    assertBullmqSafeName(name);
    this.name = name;
    bullmqMockState.queueEventsInstances.push(this);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export const bullmqMockState = {
  queueInstances: [] as BullmqQueueMock[],
  workerInstances: [] as BullmqWorkerMock[],
  queueEventsInstances: [] as BullmqQueueEventsMock[],
  /** Reset the registries between tests. Per-instance state on existing
   * mock objects is not cleared — those should be GC'd once the test
   * releases its references. */
  reset(): void {
    bullmqMockState.queueInstances.length = 0;
    bullmqMockState.workerInstances.length = 0;
    bullmqMockState.queueEventsInstances.length = 0;
  },
};

export function findQueueByName(name: string): BullmqQueueMock | undefined {
  return bullmqMockState.queueInstances.find((q) => q.name === name);
}

/**
 * Aggregate every `upsertJobScheduler` call across every queue instance
 * created so far in this test. Used by `scheduler.service.test.ts`, which
 * registers schedulers across multiple per-agent task queues and asserts
 * over the aggregated set.
 */
export function getAllUpsertJobSchedulerCalls(): Array<
  BullmqUpsertSchedulerCall & { queueName: string }
> {
  return bullmqMockState.queueInstances.flatMap((q) =>
    q.upsertJobSchedulerCalls.map((call) => ({ queueName: q.name, ...call })),
  );
}

export const bullmqMockModule = {
  Queue: BullmqQueueMock,
  Worker: BullmqWorkerMock,
  QueueEvents: BullmqQueueEventsMock,
};
