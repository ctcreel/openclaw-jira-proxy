import type {
  ClawndomEvent,
  JobRequeuedEvent,
  JobStartedEvent,
  WebhookAcceptedEvent,
} from '../types/clawndom-event';
import { getEventBus } from './event-bus.service';

export interface ActiveJobContext {
  id: string;
  title: string;
  status: string;
}

export interface ActiveJob {
  jobId: string;
  traceId: string;
  provider: string;
  agentId: string;
  template: string | null;
  runner: string;
  model: string | null;
  startedAt: number;
  context: ActiveJobContext | null;
}

/**
 * In-process registry of currently-running jobs. Subscribes to the EventBus
 * so a late-connecting dashboard client can bootstrap its active-job state
 * via `GET /api/jobs/active` without replaying the full SSE history.
 *
 * Scope matches the EventBus — this process only. A restart clears the map
 * and pre-restart jobs stay invisible until the next event lands.
 */
export class ActiveJobsRegistry {
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly pendingContext = new Map<string, ActiveJobContext>();
  private unsubscribe: (() => void) | null = null;

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
    this.jobs.clear();
    this.pendingContext.clear();
  }

  listActive(): ActiveJob[] {
    return [...this.jobs.values()];
  }

  /**
   * True when an in-process `webhook.accepted` has populated context for
   * this traceId. The worker uses this to decide whether to re-emit
   * `webhook.accepted` from the recovery path: if pending-context already
   * exists, the in-process ingest already published it and a re-emit
   * would just duplicate the SSE frame.
   */
  hasPendingContext(traceId: string): boolean {
    return this.pendingContext.has(traceId);
  }

  private handleEvent(event: ClawndomEvent): void {
    switch (event.type) {
      case 'webhook.accepted':
        this.recordContext(event);
        return;
      case 'job.started':
        this.registerStarted(event);
        return;
      case 'job.requeued':
        // Quota-aware pause path: handleQuotaExceeded re-enqueues the same
        // envelope for delayed delivery and emits job.requeued. The just-
        // paused jobId carries on in this map otherwise — drop it so the
        // active panel reflects reality. pendingContext is keyed by
        // traceId and the trace is preserved across the requeue, so we
        // leave that intact for the resumed pickup.
        this.handleRequeued(event);
        return;
      case 'job.completed':
        this.jobs.delete(event.jobId);
        this.pendingContext.delete(event.traceId);
        return;
      case 'job.failed':
        // Remove on any failure — non-final failures get a fresh jobId on
        // requeue, so the current jobId is no longer active.
        this.jobs.delete(event.jobId);
        if (event.final) {
          this.pendingContext.delete(event.traceId);
        }
        return;
      default:
        return;
    }
  }

  private recordContext(event: WebhookAcceptedEvent): void {
    this.pendingContext.set(event.traceId, {
      id: event.contextId,
      title: event.contextTitle,
      status: event.contextStatus,
    });
  }

  private handleRequeued(event: JobRequeuedEvent): void {
    // The `originalJobId` field is the BullMQ id of the prior generation
    // (just-paused or just-failed-non-final). For the failure-handler
    // retry path the corresponding entry is already gone (job.failed
    // deleted it before requeue fires); for the quota-pause path this is
    // the only event that names the paused id. Idempotent either way.
    this.jobs.delete(event.originalJobId);
  }

  private registerStarted(event: JobStartedEvent): void {
    const context = this.pendingContext.get(event.traceId) ?? null;
    this.jobs.set(event.jobId, {
      jobId: event.jobId,
      traceId: event.traceId,
      provider: event.provider,
      agentId: event.agentId,
      template: event.template ?? null,
      runner: event.runner,
      model: event.model ?? null,
      startedAt: event.timestamp,
      context,
    });
  }
}

let instance: ActiveJobsRegistry | null = null;

export function getActiveJobsRegistry(): ActiveJobsRegistry {
  if (instance === null) {
    instance = new ActiveJobsRegistry();
    instance.start();
  }
  return instance;
}

export function resetActiveJobsRegistry(): void {
  if (instance !== null) {
    instance.stop();
  }
  instance = null;
}
