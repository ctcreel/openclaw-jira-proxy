import type IORedis from 'ioredis';

import { getLogger } from '../lib/logging';
import type {
  ClawndomEvent,
  JobCompletedEvent,
  JobFailedEvent,
  JobPausedEvent,
  JobRetriedEvent,
  JobStartedEvent,
  WebhookAcceptedEvent,
} from '../types/clawndom-event';
import { getDedupRedis } from './dedup.service';
import { getEventBus } from './event-bus.service';

const logger = getLogger('inflight-registry');

const INFLIGHT_KEY_PREFIX = 'clawndom:inflight:';
const INFLIGHT_TTL_SECONDS = 24 * 60 * 60;

export function buildInflightKey(traceId: string): string {
  return `${INFLIGHT_KEY_PREFIX}${traceId}`;
}

export interface InflightRecord {
  readonly traceId: string;
  readonly jobId: string;
  readonly provider: string;
  readonly agentId: string;
  readonly contextId?: string;
  readonly contextTitle?: string;
  readonly contextStatus?: string;
  readonly startedAt: number;
  readonly lastEventAt: number;
  readonly lastEventType: string;
}

interface PendingContext {
  readonly contextId: string;
  readonly contextTitle: string;
  readonly contextStatus: string;
}

/**
 * Durable, Redis-backed Observer over the EventBus. Records the lifecycle
 * of every job from `job.started` through a terminal event, keyed by
 * `traceId` so retries (which keep the trace but mint a fresh jobId) update
 * a single inflight record.
 *
 * Companion to {@link ../active-jobs.service.ts} ActiveJobsRegistry — both
 * subscribe to the same EventBus, but this consumer survives process
 * restarts (the in-process map does not). The two have different lifetimes
 * and storage; conflating them was the structural deficiency that let
 * SPE-1973 stay invisibly stuck in `In Development` for ~8 hours.
 */
export class InflightRegistry {
  private readonly pendingContext = new Map<string, PendingContext>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly redis: IORedis) {}

  start(): void {
    if (this.unsubscribe !== null) {
      return;
    }
    this.unsubscribe = getEventBus().subscribe((stamped) => {
      const event = stamped.event;
      this.handleEvent(event).catch((err) => {
        logger.error(
          {
            error: err instanceof Error ? err.message : String(err),
            eventType: event.type,
            traceId: 'traceId' in event ? event.traceId : undefined,
          },
          'inflight-registry:handler-error',
        );
      });
    });
  }

  stop(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.pendingContext.clear();
  }

  /** Test/inspection hook. Reads the current durable record for a traceId. */
  async readRecord(traceId: string): Promise<InflightRecord | null> {
    const raw = await this.redis.hgetall(buildInflightKey(traceId));
    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }
    return parseInflightHash(raw);
  }

  private async handleEvent(event: ClawndomEvent): Promise<void> {
    switch (event.type) {
      case 'webhook.accepted':
        this.recordPendingContext(event);
        return;
      case 'job.started':
        await this.recordStarted(event);
        return;
      case 'job.paused':
        await this.touch(event, 'job.paused');
        return;
      case 'job.retried':
        await this.touch(event, 'job.retried');
        return;
      case 'runner.assistant_text':
      case 'runner.tool_call':
      case 'runner.result':
      case 'runner.complete':
      case 'runner.error':
        await this.touch(event, event.type);
        return;
      case 'job.completed':
        await this.clear(event);
        return;
      case 'job.failed':
        if (event.final) {
          await this.clearOnFinalFailure(event);
        }
        return;
      default:
        return;
    }
  }

  private recordPendingContext(event: WebhookAcceptedEvent): void {
    this.pendingContext.set(event.traceId, {
      contextId: event.contextId,
      contextTitle: event.contextTitle,
      contextStatus: event.contextStatus,
    });
  }

  private async recordStarted(event: JobStartedEvent): Promise<void> {
    const context = this.pendingContext.get(event.traceId);
    const record: Record<string, string> = {
      traceId: event.traceId,
      jobId: event.jobId,
      provider: event.provider,
      agentId: event.agentId,
      startedAt: String(event.timestamp),
      lastEventAt: String(event.timestamp),
      lastEventType: 'job.started',
    };
    if (context) {
      record['contextId'] = context.contextId;
      record['contextTitle'] = context.contextTitle;
      record['contextStatus'] = context.contextStatus;
    }
    const key = buildInflightKey(event.traceId);
    await this.redis.hset(key, record);
    await this.redis.expire(key, INFLIGHT_TTL_SECONDS);
  }

  private async touch(
    event: JobPausedEvent | JobRetriedEvent | { traceId: string; timestamp: number },
    eventType: string,
  ): Promise<void> {
    const key = buildInflightKey(event.traceId);
    // HEXISTS guards against touching a key that's already been DELed by a
    // terminal event — without it, `hset` would resurrect a dead inflight
    // record with only the lastEventAt fields populated.
    const exists = await this.redis.exists(key);
    if (!exists) {
      return;
    }
    await this.redis.hset(key, {
      lastEventAt: String(event.timestamp),
      lastEventType: eventType,
    });
  }

  private async clear(event: JobCompletedEvent): Promise<void> {
    await this.redis.del(buildInflightKey(event.traceId));
    this.pendingContext.delete(event.traceId);
  }

  private async clearOnFinalFailure(event: JobFailedEvent): Promise<void> {
    await this.redis.del(buildInflightKey(event.traceId));
    this.pendingContext.delete(event.traceId);
  }
}

export function parseInflightHash(raw: Record<string, string>): InflightRecord | null {
  const traceId = raw['traceId'];
  const jobId = raw['jobId'];
  const provider = raw['provider'];
  const agentId = raw['agentId'];
  const startedAtRaw = raw['startedAt'];
  const lastEventAtRaw = raw['lastEventAt'];
  const lastEventType = raw['lastEventType'];
  if (
    traceId === undefined ||
    jobId === undefined ||
    provider === undefined ||
    agentId === undefined ||
    startedAtRaw === undefined ||
    lastEventAtRaw === undefined ||
    lastEventType === undefined
  ) {
    return null;
  }
  const startedAt = Number(startedAtRaw);
  const lastEventAt = Number(lastEventAtRaw);
  if (Number.isNaN(startedAt) || Number.isNaN(lastEventAt)) {
    return null;
  }
  const record: InflightRecord = {
    traceId,
    jobId,
    provider,
    agentId,
    startedAt,
    lastEventAt,
    lastEventType,
    ...(raw['contextId'] !== undefined ? { contextId: raw['contextId'] } : {}),
    ...(raw['contextTitle'] !== undefined ? { contextTitle: raw['contextTitle'] } : {}),
    ...(raw['contextStatus'] !== undefined ? { contextStatus: raw['contextStatus'] } : {}),
  };
  return record;
}

let instance: InflightRegistry | null = null;

export function getInflightRegistry(): InflightRegistry {
  if (instance === null) {
    instance = new InflightRegistry(getDedupRedis());
    instance.start();
  }
  return instance;
}

export function resetInflightRegistry(): void {
  if (instance !== null) {
    instance.stop();
  }
  instance = null;
}
