import type { ActiveJobContext } from './active-jobs.service';
import { getEventBus } from './event-bus.service';
import type {
  ClawndomEvent,
  JobCompletedEvent,
  JobFailedEvent,
  JobStartedEvent,
  WebhookAcceptedEvent,
  WebhookRejectedEvent,
} from '../types/clawndom-event';

const DEFAULT_BUFFER_SIZE = 50;

export type RecentOutcome = 'completed' | 'failed' | 'rejected';

export interface RecentCompletion {
  jobId: string;
  traceId: string;
  provider: string;
  agentId: string | null;
  context: ActiveJobContext | null;
  completedAt: number;
  outcome: RecentOutcome;
  durationMs?: number;
  error?: string;
  reason?: WebhookRejectedEvent['reason'];
}

interface LiveJobState {
  agentId: string;
  provider: string;
}

/**
 * In-process registry of recently-finished work — completed jobs, final
 * failed jobs, and webhook rejections (excluding `no-routing-match` Jira
 * fan-out noise). Mirrors `ActiveJobsRegistry` in shape so the dashboard
 * can hydrate `STATE.recent` from a snapshot endpoint without replaying
 * the full SSE history.
 *
 * Like the rest of the bus-derived registries, scope is per-process and a
 * restart starts empty. SPE-1976.
 */
export class RecentCompletionsRegistry {
  private readonly bufferSize: number;
  private readonly buffer: RecentCompletion[] = [];
  private readonly pendingContext = new Map<string, ActiveJobContext>();
  private readonly liveJobs = new Map<string, LiveJobState>();
  private unsubscribe: (() => void) | null = null;

  constructor(bufferSize: number = DEFAULT_BUFFER_SIZE) {
    this.bufferSize = Math.max(1, bufferSize);
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
    this.buffer.length = 0;
    this.pendingContext.clear();
    this.liveJobs.clear();
  }

  list(): RecentCompletion[] {
    return [...this.buffer];
  }

  private handleEvent(event: ClawndomEvent): void {
    switch (event.type) {
      case 'webhook.accepted':
        this.recordContext(event);
        return;
      case 'webhook.rejected':
        this.handleRejected(event);
        return;
      case 'job.started':
        this.recordLiveJob(event);
        return;
      case 'job.completed':
        this.recordCompleted(event);
        return;
      case 'job.failed':
        this.recordFailed(event);
        return;
      default:
        return;
    }
  }

  private record(entry: RecentCompletion): void {
    this.buffer.unshift(entry);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.length = this.bufferSize;
    }
  }

  private recordContext(event: WebhookAcceptedEvent): void {
    this.pendingContext.set(event.traceId, {
      id: event.contextId,
      title: event.contextTitle,
      status: event.contextStatus,
    });
  }

  private recordLiveJob(event: JobStartedEvent): void {
    this.liveJobs.set(event.jobId, {
      agentId: event.agentId,
      provider: event.provider,
    });
  }

  private handleRejected(event: WebhookRejectedEvent): void {
    // no-routing-match fires constantly on every Jira ticket edit whose new
    // status doesn't match a routing rule; including it here would drown
    // real outcomes in the dashboard's recent panel.
    if (event.reason === 'no-routing-match') {
      return;
    }
    this.record({
      jobId: '',
      traceId: event.traceId,
      provider: event.provider,
      agentId: null,
      context: null,
      completedAt: event.timestamp,
      outcome: 'rejected',
      reason: event.reason,
    });
  }

  private recordCompleted(event: JobCompletedEvent): void {
    const live = this.liveJobs.get(event.jobId) ?? null;
    const context = this.pendingContext.get(event.traceId) ?? null;
    this.record({
      jobId: event.jobId,
      traceId: event.traceId,
      provider: event.provider,
      agentId: live?.agentId ?? null,
      context,
      completedAt: event.timestamp,
      outcome: 'completed',
      durationMs: event.durationMs,
    });
    this.liveJobs.delete(event.jobId);
    this.pendingContext.delete(event.traceId);
  }

  private recordFailed(event: JobFailedEvent): void {
    // Non-final failures are followed by a job.requeued + a fresh job.started;
    // logging them here would inflate the recent count and confuse the
    // operator about which failures are real terminal outcomes.
    if (!event.final) {
      this.liveJobs.delete(event.jobId);
      return;
    }
    const live = this.liveJobs.get(event.jobId) ?? null;
    const context = this.pendingContext.get(event.traceId) ?? null;
    this.record({
      jobId: event.jobId,
      traceId: event.traceId,
      provider: event.provider,
      agentId: live?.agentId ?? null,
      context,
      completedAt: event.timestamp,
      outcome: 'failed',
      error: event.error,
    });
    this.liveJobs.delete(event.jobId);
    this.pendingContext.delete(event.traceId);
  }
}

let instance: RecentCompletionsRegistry | null = null;

export function getRecentCompletionsRegistry(): RecentCompletionsRegistry {
  if (instance === null) {
    instance = new RecentCompletionsRegistry();
    instance.start();
  }
  return instance;
}

export function resetRecentCompletionsRegistry(): void {
  if (instance !== null) {
    instance.stop();
  }
  instance = null;
}
