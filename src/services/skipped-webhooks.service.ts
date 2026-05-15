import type { ClawndomEvent, WebhookRejectedEvent } from '../types/clawndom-event';
import { getEventBus } from './event-bus.service';

export interface SkippedWebhook {
  timestamp: number;
  traceId: string;
  provider: string;
  reason: WebhookRejectedEvent['reason'];
  contextId?: string;
  contextStatus?: string;
  contextTitle?: string;
}

export interface SkippedWebhookCounts {
  noMatch: number;
  duplicate: number;
  signatureFailure: number;
  senderGateRefusal: number;
}

export interface SkippedWebhooksRegistryOptions {
  capacity?: number;
}

const DEFAULT_CAPACITY = 100;

/**
 * In-process registry of recently-rejected webhooks. Subscribes to the
 * EventBus and answers two questions the dashboard couldn't ask before:
 *
 *   1. How are rejections distributed across reasons? (`getCounts()`)
 *   2. Which specific webhooks were dropped, with what context? (`listRecent()`)
 *
 * Bounded ring (capacity 100 by default) — oldest entries fall out on
 * overflow. Counts are cumulative since the registry started; they reflect
 * total observed rejections regardless of ring eviction. Lifecycle
 * mirrors ActiveJobsRegistry: eagerly bootstrapped in startWorkers so a
 * dashboard that connects mid-run can seed itself via REST.
 */
export class SkippedWebhooksRegistry {
  private readonly capacity: number;
  // Newest entries pushed at index 0 — listRecent() can slice without reverse.
  private readonly ring: SkippedWebhook[] = [];
  private counts: SkippedWebhookCounts = {
    noMatch: 0,
    duplicate: 0,
    signatureFailure: 0,
    senderGateRefusal: 0,
  };
  private unsubscribe: (() => void) | null = null;

  constructor(options: SkippedWebhooksRegistryOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
  }

  start(): void {
    if (this.unsubscribe !== null) {
      return;
    }
    this.unsubscribe = getEventBus().subscribe((stamped) => this.handleEvent(stamped.event));
  }

  stop(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.ring.length = 0;
    this.counts = { noMatch: 0, duplicate: 0, signatureFailure: 0, senderGateRefusal: 0 };
  }

  /**
   * Returns the most-recent rejections, newest first. `limit` is clamped
   * to [0, capacity]; values outside that range are coerced rather than
   * rejected so a dashboard misconfig can't 400 the endpoint.
   */
  listRecent(limit: number = this.capacity): SkippedWebhook[] {
    const safe = Math.max(0, Math.min(this.capacity, Math.floor(limit)));
    return this.ring.slice(0, safe);
  }

  getCounts(): SkippedWebhookCounts {
    return { ...this.counts };
  }

  private handleEvent(event: ClawndomEvent): void {
    if (event.type !== 'webhook.rejected') {
      return;
    }
    this.record(event);
  }

  private record(event: WebhookRejectedEvent): void {
    const entry: SkippedWebhook = {
      timestamp: event.timestamp,
      traceId: event.traceId,
      provider: event.provider,
      reason: event.reason,
      ...(event.contextId !== undefined && { contextId: event.contextId }),
      ...(event.contextStatus !== undefined && { contextStatus: event.contextStatus }),
      ...(event.contextTitle !== undefined && { contextTitle: event.contextTitle }),
    };
    this.ring.unshift(entry);
    if (this.ring.length > this.capacity) {
      this.ring.length = this.capacity;
    }
    switch (event.reason) {
      case 'no-routing-match':
        this.counts.noMatch += 1;
        return;
      case 'duplicate':
        this.counts.duplicate += 1;
        return;
      case 'invalid-signature':
      case 'missing-signature':
        this.counts.signatureFailure += 1;
        return;
      case 'sender-gate-refusal':
        this.counts.senderGateRefusal += 1;
        return;
    }
  }
}

let instance: SkippedWebhooksRegistry | null = null;

export function getSkippedWebhooksRegistry(): SkippedWebhooksRegistry {
  if (instance === null) {
    instance = new SkippedWebhooksRegistry();
    instance.start();
  }
  return instance;
}

export function resetSkippedWebhooksRegistry(): void {
  if (instance !== null) {
    instance.stop();
  }
  instance = null;
}
