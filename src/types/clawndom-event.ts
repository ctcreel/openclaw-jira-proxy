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

export type ClawndomEvent =
  | WebhookReceivedEvent
  | WebhookAcceptedEvent
  | WebhookRejectedEvent
  | JobQueuedEvent
  | JobRequeuedEvent
  | JobStartedEvent
  | JobCompletedEvent
  | JobFailedEvent
  | RunnerAssistantTextEvent
  | RunnerToolCallEvent
  | RunnerResultEvent
  | SocketConnectedEvent
  | SocketDisconnectedEvent
  | SocketReconnectingEvent
  | SocketAuthFailedEvent;
