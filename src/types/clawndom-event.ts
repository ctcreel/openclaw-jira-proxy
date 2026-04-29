/**
 * Typed event stream that Clawndom emits over SSE (`/api/events`).
 *
 * Every event has a `type` discriminator, a millisecond `timestamp`, and
 * `traceId` (the logical run identifier — job id, or originalJobId for
 * retries) so a consumer can assemble the per-job story without joins.
 */

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
  reason: 'invalid-signature' | 'missing-signature' | 'no-routing-match' | 'duplicate';
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

export interface JobRequeuedEvent {
  type: 'job.requeued';
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

export type ClawndomEvent =
  | WebhookReceivedEvent
  | WebhookAcceptedEvent
  | WebhookRejectedEvent
  | JobQueuedEvent
  | JobRequeuedEvent
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
  | MemoryErrorEvent;

  | SessionSpawnedEvent
  | SessionResumedEvent
  | SessionReapedEvent
  | SessionStaleEvent
  | SessionErrorEvent;
