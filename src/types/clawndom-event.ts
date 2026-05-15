/**
 * Typed event stream that Clawndom emits over SSE (`/api/events`).
 *
 * Every event has a `type` discriminator, a millisecond `timestamp`, and
 * `traceId` (the logical run identifier — job id, or originalJobId for
 * retries) so a consumer can assemble the per-job story without joins.
 */

import type { ScheduledTaskCreatedBy } from './scheduled-task';

export type ClawndomEventType = ClawndomEvent['type'];

export interface WebhookReceivedEvent {
  type: 'webhook.received';
  timestamp: number;
  traceId: string;
  provider: string;
  rawHeadersHash: string;
}

export interface WebhookAcceptedEvent {
  type: 'webhook.accepted';
  timestamp: number;
  traceId: string;
  provider: string;
  contextId: string;
  contextTitle: string;
  contextStatus: string;
}

export interface WebhookRejectedEvent {
  type: 'webhook.rejected';
  timestamp: number;
  traceId: string;
  provider: string;
  reason:
    | 'invalid-signature'
    | 'missing-signature'
    | 'no-routing-match'
    | 'duplicate'
    | 'sender-gate-refusal';
  // Optional because signature-failure rejections happen before the body is
  // parsed — there's no payload to extract context from. Routing rejections
  // (no-routing-match, duplicate) populate these from extractWebhookContext.
  contextId?: string;
  contextStatus?: string;
  contextTitle?: string;
}

export interface JobQueuedEvent {
  type: 'job.queued';
  timestamp: number;
  traceId: string;
  jobId: string;
  provider: string;
  contextId: string;
  contextTitle: string;
}

/**
 * Quota-pause re-enqueue. Emitted when a runner reports `quota_exceeded` and
 * the worker re-enqueues the same envelope with a delay until the upstream
 * reset time. Distinct from `job.retried` because the operational meaning is
 * "expected wait until a known timestamp," not "something failed and we're
 * trying again." Carries `resumeAt` so consumers can render a countdown.
 */
export interface JobPausedEvent {
  type: 'job.paused';
  timestamp: number;
  traceId: string;
  jobId: string;
  provider: string;
  attempt: number;
  originalJobId: string;
  resumeAt: number;
}

/**
 * Failure-handler retry re-enqueue. Emitted when a job fails non-finally and
 * the worker requeues it with exponential backoff. Distinct from `job.paused`
 * because this represents an actual failure that may recur, not a known wait.
 */
export interface JobRetriedEvent {
  type: 'job.retried';
  timestamp: number;
  traceId: string;
  jobId: string;
  provider: string;
  attempt: number;
  originalJobId: string;
}

export interface JobStartedEvent {
  type: 'job.started';
  timestamp: number;
  traceId: string;
  jobId: string;
  provider: string;
  agentId: string;
  template?: string;
  runner: string;
  model?: string;
}

export interface JobCompletedEvent {
  type: 'job.completed';
  timestamp: number;
  traceId: string;
  jobId: string;
  provider: string;
  durationMs: number;
  runId: string;
}

export interface JobFailedEvent {
  type: 'job.failed';
  timestamp: number;
  traceId: string;
  jobId: string;
  provider: string;
  error: string;
  attempt: number;
  final: boolean;
}

export interface RunnerAssistantTextEvent {
  type: 'runner.assistant_text';
  timestamp: number;
  traceId: string;
  jobId: string;
  runId: string;
  text: string;
}

export interface RunnerToolCallEvent {
  type: 'runner.tool_call';
  timestamp: number;
  traceId: string;
  jobId: string;
  runId: string;
  tool: string;
  args?: unknown;
}

export interface RunnerResultEvent {
  type: 'runner.result';
  timestamp: number;
  traceId: string;
  jobId: string;
  runId: string;
  turns: number;
  costUsd: number;
}

export interface RunnerCompleteEvent {
  type: 'runner.complete';
  timestamp: number;
  traceId: string;
  jobId: string;
  runId: string;
  exitCode: number;
  durationMs: number;
}

export type RunnerErrorReason = 'non-zero-exit' | 'timeout' | 'signal' | 'spawn-error';

export interface RunnerErrorEvent {
  type: 'runner.error';
  timestamp: number;
  traceId: string;
  jobId: string;
  runId: string;
  reason: RunnerErrorReason;
  exitCode?: number;
  signal?: string;
  stderrTail: string;
}

export type JobOrphanedReason = 'no-terminal-event' | 'queue-state-mismatch';

export interface JobOrphanedEvent {
  type: 'job.orphaned';
  timestamp: number;
  traceId: string;
  jobId: string;
  provider: string;
  agentId: string;
  contextId?: string;
  contextTitle?: string;
  contextStatus?: string;
  lastEventAt: number;
  lastEventType: string;
  reason: JobOrphanedReason;
}

export interface SocketConnectedEvent {
  type: 'socket.connected';
  timestamp: number;
  traceId: string;
  provider: string;
}

export interface SocketDisconnectedEvent {
  type: 'socket.disconnected';
  timestamp: number;
  traceId: string;
  provider: string;
  reason: string;
}

export interface SocketReconnectingEvent {
  type: 'socket.reconnecting';
  timestamp: number;
  traceId: string;
  provider: string;
  attempt: number;
}

export interface SocketAuthFailedEvent {
  type: 'socket.auth_failed';
  timestamp: number;
  traceId: string;
  provider: string;
  reason: string;
}

export interface MemoryStoredEvent {
  type: 'memory.stored';
  timestamp: number;
  traceId: string;
  namespace: string;
  id: string;
  textLength: number;
}

export interface MemoryRetrievedEvent {
  type: 'memory.retrieved';
  timestamp: number;
  traceId: string;
  namespace: string;
  queryLength: number;
  hitCount: number;
  topScore?: number;
}

export interface MemoryPrunedEvent {
  type: 'memory.pruned';
  timestamp: number;
  traceId: string;
  namespace: string;
  deletedCount: number;
  durationMs: number;
}

export interface MemoryErrorEvent {
  type: 'memory.error';
  timestamp: number;
  traceId: string;
  namespace?: string;
  operation: 'store' | 'search' | 'delete' | 'prune';
  errorMessage: string;
}

export interface SessionSpawnedEvent {
  type: 'session.spawned';
  timestamp: number;
  traceId: string;
  provider: string;
  key: string;
  session_id: string;
  mode: 'fresh' | 'resume';
}

export interface SessionResumedEvent {
  type: 'session.resumed';
  timestamp: number;
  traceId: string;
  provider: string;
  key: string;
  session_id: string;
  mode: 'resume';
}

export interface SessionReapedEvent {
  type: 'session.reaped';
  timestamp: number;
  traceId: string;
  provider: string;
  key: string;
  idle_for_ms: number;
}

export interface SessionStaleEvent {
  type: 'session.stale';
  timestamp: number;
  traceId: string;
  provider: string;
  key: string;
  prior_session_id: string;
  reason: string;
}

export interface SessionErrorEvent {
  type: 'session.error';
  timestamp: number;
  traceId: string;
  provider: string;
  key: string;
  error_message: string;
}

export interface SessionEvictedEvent {
  type: 'session.evicted';
  timestamp: number;
  traceId: string;
  provider: string;
  key: string;
  reason: 'lru_capacity';
  active_after: number;
}

// Scheduled-task lifecycle. The registry (`src/services/scheduled-tasks.service.ts`)
// owns these emissions; the dashboard's "what's coming up" panel — and any
// future REST/SSE consumer — assembles its view from this stream alone.
//
// Payload shape rule: every variant carries `taskId`, `agentId`, and `runner`
// so a subscriber can render a row from the event without needing a follow-up
// `GET /api/scheduled-tasks/:id`. Phase 3's dashboard work depends on it.
//
// `reason` is a closed enum per variant, not a free-text string — observers
// can branch on it without parsing English. New origins land as new enum
// values (additive); never overload an existing one.

export type ScheduledTaskCreatedReason = 'config-load' | 'api-create' | 'agent-create';
export type ScheduledTaskCancelledReason = 'api-delete' | 'config-reconcile' | 'agent-cancel';
export type ScheduledTaskExpiredReason = 'ttl' | 'maxRuns';

export interface ScheduledTaskCreatedEvent {
  type: 'scheduled-task.created';
  timestamp: number;
  traceId: string;
  taskId: string;
  agentId: string;
  runner: string;
  createdBy: ScheduledTaskCreatedBy;
  reason: ScheduledTaskCreatedReason;
  /** trace id the creator passed in (if any) — distinct from the event's own traceId. */
  ownerTraceId?: string;
  /** Wall-clock millis of next planned firing, when the registry can compute it. */
  nextFireAt?: number;
}

export interface ScheduledTaskFiredEvent {
  type: 'scheduled-task.fired';
  timestamp: number;
  traceId: string;
  taskId: string;
  agentId: string;
  runner: string;
  /** BullMQ job id of the firing — links the lifecycle event to the eventual `runner.complete`. */
  jobId: string;
}

export interface ScheduledTaskCancelledEvent {
  type: 'scheduled-task.cancelled';
  timestamp: number;
  traceId: string;
  taskId: string;
  agentId: string;
  runner: string;
  reason: ScheduledTaskCancelledReason;
}

export interface ScheduledTaskExpiredEvent {
  type: 'scheduled-task.expired';
  timestamp: number;
  traceId: string;
  taskId: string;
  agentId: string;
  runner: string;
  reason: ScheduledTaskExpiredReason;
}

export type ClawndomEvent =
  | WebhookReceivedEvent
  | WebhookAcceptedEvent
  | WebhookRejectedEvent
  | JobQueuedEvent
  | JobPausedEvent
  | JobRetriedEvent
  | JobStartedEvent
  | JobCompletedEvent
  | JobFailedEvent
  | JobOrphanedEvent
  | RunnerAssistantTextEvent
  | RunnerToolCallEvent
  | RunnerResultEvent
  | RunnerCompleteEvent
  | RunnerErrorEvent
  | SocketConnectedEvent
  | SocketDisconnectedEvent
  | SocketReconnectingEvent
  | SocketAuthFailedEvent
  | MemoryStoredEvent
  | MemoryRetrievedEvent
  | MemoryPrunedEvent
  | MemoryErrorEvent
  | SessionSpawnedEvent
  | SessionResumedEvent
  | SessionReapedEvent
  | SessionStaleEvent
  | SessionErrorEvent
  | SessionEvictedEvent
  | ScheduledTaskCreatedEvent
  | ScheduledTaskFiredEvent
  | ScheduledTaskCancelledEvent
  | ScheduledTaskExpiredEvent;
