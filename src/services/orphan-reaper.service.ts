import { Queue, Worker } from 'bullmq';
import type { JobType } from 'bullmq';
import IORedis from 'ioredis';

import { getSettings } from '../config';
import { getLogger } from '../lib/logging';
import type { JobAlert } from './alerts';
import type { AlertRegistry } from './alerts';
import { getDedupRedis } from './dedup.service';
import { getEventBus } from './event-bus.service';
import { parseInflightHash, type InflightRecord } from './inflight-registry.service';
import { getProviderQueue } from './queue.service';

const logger = getLogger('orphan-reaper');

const INFLIGHT_KEY_GLOB = 'clawndom:inflight:*';
const SCAN_BATCH_SIZE = 100;
const REAPER_QUEUE_NAME = 'clawndom:reaper';
const REAPER_SCHEDULER_ID = 'clawndom:orphan-reaper';
const REAPER_JOB_NAME = 'orphan-reap';

/**
 * BullMQ states that signal the worker is no longer holding the job. A stale
 * inflight record whose underlying BullMQ job is in any of these states (or
 * does not exist at all) is treated as an orphan: the worker process died
 * after `job.started` was published but before any terminal event landed.
 *
 * `active` and `waiting`/`delayed` are intentionally excluded — those mean
 * BullMQ's stalled-recovery still owns the job and will re-deliver it.
 */
const ORPHAN_ELIGIBLE_BULLMQ_STATES: ReadonlySet<JobType | 'unknown'> = new Set<
  JobType | 'unknown'
>(['completed', 'failed', 'unknown']);

export interface ReapResult {
  readonly scanned: number;
  readonly orphaned: number;
}

interface FetchedInflight {
  readonly key: string;
  readonly record: InflightRecord;
}

/**
 * Periodic sweeper that detects orphaned runs — inflight records whose
 * underlying BullMQ job has terminated (or vanished) without ever publishing
 * a terminal `job.completed` / `job.failed(final=true)` event.
 *
 * Layered on top of the in-process {@link ../active-jobs.service.ts}
 * registry (dashboard snapshot) and BullMQ's built-in stalled-recovery
 * (in-process job hangs). Closes the gap neither handles: full process
 * death between `job.started` and a terminal event, where the Jira ticket
 * sits in `In Development` indefinitely.
 *
 * Phase 1 scope: detect + alert. Auto-revert is Phase 2 (SPE follow-up).
 */
export class OrphanReaper {
  private connection: IORedis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private orphanedSubscription: (() => void) | null = null;

  constructor(
    private readonly redis: IORedis,
    private readonly thresholdMs: number,
    private readonly intervalMs: number,
    private readonly alertRegistry?: AlertRegistry,
  ) {}

  async start(): Promise<void> {
    if (this.worker !== null) {
      return;
    }
    const settings = getSettings();
    this.connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(REAPER_QUEUE_NAME, { connection: this.connection });
    this.worker = new Worker(
      REAPER_QUEUE_NAME,
      async () => {
        await this.reapOnce();
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (_job, err) => {
      logger.error({ error: err.message }, 'orphan-reaper:reap-pass-failed');
    });
    if (this.alertRegistry) {
      this.orphanedSubscription = this.subscribeAlerts(this.alertRegistry);
    }
    await this.queue.upsertJobScheduler(
      REAPER_SCHEDULER_ID,
      { every: this.intervalMs },
      {
        name: REAPER_JOB_NAME,
        data: '',
        opts: {
          removeOnComplete: { count: 10 },
          removeOnFail: { count: 10 },
        },
      },
    );
    logger.info(
      { thresholdMs: this.thresholdMs, intervalMs: this.intervalMs },
      'orphan-reaper:started',
    );
  }

  async stop(): Promise<void> {
    if (this.orphanedSubscription !== null) {
      this.orphanedSubscription();
      this.orphanedSubscription = null;
    }
    if (this.worker !== null) {
      await this.worker.close();
      this.worker = null;
    }
    if (this.queue !== null) {
      await this.queue.close();
      this.queue = null;
    }
    if (this.connection !== null) {
      this.connection.disconnect();
      this.connection = null;
    }
  }

  /** Single sweep of the inflight registry. Public so tests can drive it directly. */
  async reapOnce(now: number = Date.now()): Promise<ReapResult> {
    const inflights = await this.fetchInflights();
    if (inflights.length === 0) {
      return { scanned: 0, orphaned: 0 };
    }
    const stale = inflights.filter((i) => now - i.record.lastEventAt > this.thresholdMs);
    if (stale.length === 0) {
      return { scanned: inflights.length, orphaned: 0 };
    }
    const verdicts = await Promise.all(stale.map((i) => this.classify(i)));
    const orphans = verdicts.filter((v): v is FetchedInflight => v !== null);
    for (const orphan of orphans) {
      await this.emitOrphan(orphan, now);
    }
    return { scanned: inflights.length, orphaned: orphans.length };
  }

  private async fetchInflights(): Promise<FetchedInflight[]> {
    const keys = await this.scanKeys();
    if (keys.length === 0) {
      return [];
    }
    const hashes = await Promise.all(keys.map((k) => this.redis.hgetall(k)));
    const fetched: FetchedInflight[] = [];
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]!;
      const hash = hashes[i] ?? {};
      const record = parseInflightHash(hash);
      if (record !== null) {
        fetched.push({ key, record });
      }
    }
    return fetched;
  }

  private async scanKeys(): Promise<string[]> {
    const collected: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        INFLIGHT_KEY_GLOB,
        'COUNT',
        SCAN_BATCH_SIZE,
      );
      cursor = next;
      collected.push(...batch);
    } while (cursor !== '0');
    return collected;
  }

  private async classify(candidate: FetchedInflight): Promise<FetchedInflight | null> {
    const state = await this.lookupBullmqState(candidate.record);
    if (!ORPHAN_ELIGIBLE_BULLMQ_STATES.has(state)) {
      return null;
    }
    return candidate;
  }

  private async lookupBullmqState(record: InflightRecord): Promise<JobType | 'unknown'> {
    try {
      const queue = getProviderQueue(record.provider);
      const job = await queue.getJob(record.jobId);
      if (!job) {
        return 'unknown';
      }
      return await job.getState();
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
          provider: record.provider,
          jobId: record.jobId,
          traceId: record.traceId,
        },
        'orphan-reaper:bullmq-lookup-failed',
      );
      return 'unknown';
    }
  }

  private async emitOrphan(candidate: FetchedInflight, now: number): Promise<void> {
    const { record, key } = candidate;
    const event = {
      type: 'job.orphaned' as const,
      timestamp: now,
      traceId: record.traceId,
      jobId: record.jobId,
      provider: record.provider,
      agentId: record.agentId,
      ...(record.contextId !== undefined ? { contextId: record.contextId } : {}),
      ...(record.contextTitle !== undefined ? { contextTitle: record.contextTitle } : {}),
      ...(record.contextStatus !== undefined ? { contextStatus: record.contextStatus } : {}),
      lastEventAt: record.lastEventAt,
      lastEventType: record.lastEventType,
      reason: 'no-terminal-event' as const,
    };
    getEventBus().publish(event);
    await this.redis.del(key);
    logger.warn(
      {
        traceId: record.traceId,
        jobId: record.jobId,
        provider: record.provider,
        agentId: record.agentId,
        contextId: record.contextId,
        ageMs: now - record.lastEventAt,
        lastEventType: record.lastEventType,
      },
      'orphan-reaper:orphan-detected',
    );
  }

  private subscribeAlerts(alertRegistry: AlertRegistry): () => void {
    return getEventBus().subscribe((stamped) => {
      const event = stamped.event;
      if (event.type !== 'job.orphaned') return;
      const alert: JobAlert = {
        jobId: event.jobId,
        sessionKey: `agent:${event.agentId}:hook-${event.provider}-${event.traceId}`,
        agentId: event.agentId,
        error: `Orphaned: no terminal event in ${this.thresholdMs}ms (last=${event.lastEventType})`,
        attempts: 0,
        maxAttempts: 0,
        provider: event.provider,
        failedAt: new Date(event.timestamp),
        kind: 'orphaned',
        ...(event.contextId !== undefined ? { contextId: event.contextId } : {}),
        ...(event.contextTitle !== undefined ? { contextTitle: event.contextTitle } : {}),
        ...(event.contextStatus !== undefined ? { contextStatus: event.contextStatus } : {}),
      };
      alertRegistry.sendAll(alert).catch((err) => {
        logger.error(
          { error: err instanceof Error ? err.message : String(err), traceId: event.traceId },
          'orphan-reaper:alert-dispatch-failed',
        );
      });
    });
  }
}

let instance: OrphanReaper | null = null;

export function getOrphanReaper(alertRegistry?: AlertRegistry): OrphanReaper {
  if (instance === null) {
    const settings = getSettings();
    instance = new OrphanReaper(
      getDedupRedis(),
      settings.orphanThresholdMs,
      settings.orphanReaperIntervalMs,
      alertRegistry,
    );
  }
  return instance;
}

export async function resetOrphanReaper(): Promise<void> {
  if (instance !== null) {
    await instance.stop();
  }
  instance = null;
}
