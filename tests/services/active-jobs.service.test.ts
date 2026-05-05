import { describe, it, expect, beforeEach } from 'vitest';

import {
  ActiveJobsRegistry,
  getActiveJobsRegistry,
  resetActiveJobsRegistry,
} from '../../src/services/active-jobs.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import type {
  JobCompletedEvent,
  JobFailedEvent,
  JobStartedEvent,
  WebhookAcceptedEvent,
} from '../../src/types/clawndom-event';

function buildWebhookAccepted(overrides: Partial<WebhookAcceptedEvent> = {}): WebhookAcceptedEvent {
  return {
    type: 'webhook.accepted',
    timestamp: 1,
    traceId: 'trace-1',
    provider: 'jira',
    contextId: 'SPE-100',
    contextTitle: 'Example ticket',
    contextStatus: 'Ready for Development',
    ...overrides,
  };
}

function buildJobStarted(overrides: Partial<JobStartedEvent> = {}): JobStartedEvent {
  return {
    type: 'job.started',
    timestamp: 2,
    traceId: 'trace-1',
    jobId: 'job-1',
    provider: 'jira',
    agentId: 'patch',
    template: 'templates/jira-ready-for-dev-bug.md',
    runner: 'claude-cli',
    model: 'claude-opus-4-7',
    ...overrides,
  };
}

function buildJobCompleted(overrides: Partial<JobCompletedEvent> = {}): JobCompletedEvent {
  return {
    type: 'job.completed',
    timestamp: 3,
    traceId: 'trace-1',
    jobId: 'job-1',
    provider: 'jira',
    durationMs: 1000,
    runId: 'cli-1',
    ...overrides,
  };
}

function buildJobFailed(overrides: Partial<JobFailedEvent> = {}): JobFailedEvent {
  return {
    type: 'job.failed',
    timestamp: 3,
    traceId: 'trace-1',
    jobId: 'job-1',
    provider: 'jira',
    error: 'boom',
    attempt: 1,
    final: false,
    ...overrides,
  };
}

describe('ActiveJobsRegistry', () => {
  beforeEach(() => {
    resetEventBus();
    resetActiveJobsRegistry();
  });

  it('starts empty', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    expect(registry.listActive()).toEqual([]);
  });

  it('registers a job on job.started and joins webhook context by traceId', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildWebhookAccepted());
    bus.publish(buildJobStarted());

    const active = registry.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]).toEqual({
      jobId: 'job-1',
      traceId: 'trace-1',
      provider: 'jira',
      agentId: 'patch',
      template: 'templates/jira-ready-for-dev-bug.md',
      runner: 'claude-cli',
      model: 'claude-opus-4-7',
      startedAt: 2,
      context: { id: 'SPE-100', title: 'Example ticket', status: 'Ready for Development' },
    });
  });

  it('registers a job with null context when webhook.accepted is missing', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    getEventBus().publish(buildJobStarted());

    const active = registry.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.context).toBeNull();
  });

  it('normalises missing template and model to null', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    getEventBus().publish(buildJobStarted({ template: undefined, model: undefined }));

    const active = registry.listActive();
    expect(active[0]?.template).toBeNull();
    expect(active[0]?.model).toBeNull();
  });

  it('removes a job on job.completed', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildWebhookAccepted());
    bus.publish(buildJobStarted());
    expect(registry.listActive()).toHaveLength(1);

    bus.publish(buildJobCompleted());
    expect(registry.listActive()).toEqual([]);
  });

  it('drops the current jobId on non-final job.failed but keeps context for retries', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildWebhookAccepted());
    bus.publish(buildJobStarted());

    bus.publish(buildJobFailed({ final: false }));
    expect(registry.listActive()).toEqual([]);

    // Retry gets a fresh jobId but reuses the original traceId; context
    // should still be attached from the first attempt.
    bus.publish(buildJobStarted({ jobId: 'job-2', timestamp: 4 }));
    const active = registry.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.jobId).toBe('job-2');
    expect(active[0]?.context?.id).toBe('SPE-100');
  });

  it('clears context on final job.failed', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildWebhookAccepted());
    bus.publish(buildJobStarted());
    bus.publish(buildJobFailed({ final: true }));

    bus.publish(buildJobStarted({ jobId: 'job-2', timestamp: 5 }));
    const active = registry.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.context).toBeNull();
  });

  it('ignores events unrelated to active-job tracking', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    getEventBus().publish({
      type: 'runner.tool_call',
      timestamp: 1,
      traceId: 'trace-1',
      jobId: 'job-1',
      runId: 'cli-1',
      tool: 'Bash',
    });
    expect(registry.listActive()).toEqual([]);
  });

  it('stop() unsubscribes and clears state', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildWebhookAccepted());
    bus.publish(buildJobStarted());
    expect(registry.listActive()).toHaveLength(1);

    registry.stop();
    expect(registry.listActive()).toEqual([]);

    bus.publish(buildJobStarted({ jobId: 'job-2' }));
    expect(registry.listActive()).toEqual([]);
  });

  it('double-start is a no-op', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    registry.start();
    getEventBus().publish(buildJobStarted());
    expect(registry.listActive()).toHaveLength(1);
  });

  it('double-stop is a no-op', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    registry.stop();
    expect(() => registry.stop()).not.toThrow();
  });

  it('hasPendingContext reflects pendingContext map state across the lifecycle', () => {
    const registry = new ActiveJobsRegistry();
    registry.start();
    const bus = getEventBus();

    expect(registry.hasPendingContext('trace-1')).toBe(false);
    bus.publish(buildWebhookAccepted({ traceId: 'trace-1' }));
    expect(registry.hasPendingContext('trace-1')).toBe(true);

    // Survives non-final failure (context kept for retries).
    bus.publish(buildJobStarted({ traceId: 'trace-1' }));
    bus.publish(buildJobFailed({ traceId: 'trace-1', final: false }));
    expect(registry.hasPendingContext('trace-1')).toBe(true);

    // Cleared on final failure.
    bus.publish(buildJobFailed({ traceId: 'trace-1', final: true }));
    expect(registry.hasPendingContext('trace-1')).toBe(false);

    // Cleared on completion.
    bus.publish(buildWebhookAccepted({ traceId: 'trace-2' }));
    bus.publish(buildJobStarted({ traceId: 'trace-2', jobId: 'job-2' }));
    expect(registry.hasPendingContext('trace-2')).toBe(true);
    bus.publish(buildJobCompleted({ traceId: 'trace-2', jobId: 'job-2' }));
    expect(registry.hasPendingContext('trace-2')).toBe(false);
  });
});

describe('getActiveJobsRegistry singleton', () => {
  beforeEach(() => {
    resetEventBus();
    resetActiveJobsRegistry();
  });

  it('returns the same instance and subscribes on first call', () => {
    const a = getActiveJobsRegistry();
    const b = getActiveJobsRegistry();
    expect(a).toBe(b);

    getEventBus().publish(buildJobStarted());
    expect(a.listActive()).toHaveLength(1);
  });

  it('resetActiveJobsRegistry stops the instance and returns a fresh one', () => {
    const a = getActiveJobsRegistry();
    getEventBus().publish(buildJobStarted());
    expect(a.listActive()).toHaveLength(1);

    resetActiveJobsRegistry();
    const b = getActiveJobsRegistry();
    expect(a).not.toBe(b);
    expect(b.listActive()).toEqual([]);
  });
});
