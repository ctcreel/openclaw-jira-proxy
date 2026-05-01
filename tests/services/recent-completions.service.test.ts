import { describe, it, expect, beforeEach } from 'vitest';

import {
  RecentCompletionsRegistry,
  getRecentCompletionsRegistry,
  resetRecentCompletionsRegistry,
} from '../../src/services/recent-completions.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import type {
  JobCompletedEvent,
  JobFailedEvent,
  JobStartedEvent,
  WebhookAcceptedEvent,
  WebhookRejectedEvent,
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
    runner: 'claude-cli',
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
    timestamp: 4,
    traceId: 'trace-1',
    jobId: 'job-1',
    provider: 'jira',
    error: 'boom',
    attempt: 1,
    final: true,
    ...overrides,
  };
}

function buildWebhookRejected(overrides: Partial<WebhookRejectedEvent> = {}): WebhookRejectedEvent {
  return {
    type: 'webhook.rejected',
    timestamp: 5,
    traceId: 'trace-2',
    provider: 'jira',
    reason: 'invalid-signature',
    ...overrides,
  };
}

describe('RecentCompletionsRegistry (SPE-1976)', () => {
  beforeEach(() => {
    resetEventBus();
    resetRecentCompletionsRegistry();
  });

  it('starts empty', () => {
    const registry = new RecentCompletionsRegistry();
    registry.start();
    expect(registry.list()).toEqual([]);
  });

  it('records a completion enriched with prior webhook context', () => {
    const registry = new RecentCompletionsRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildWebhookAccepted());
    bus.publish(buildJobStarted());
    bus.publish(buildJobCompleted());

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      jobId: 'job-1',
      traceId: 'trace-1',
      provider: 'jira',
      agentId: 'patch',
      outcome: 'completed',
      durationMs: 1000,
      context: { id: 'SPE-100', title: 'Example ticket', status: 'Ready for Development' },
    });
  });

  it('records a final job.failed but excludes non-final retries', () => {
    const registry = new RecentCompletionsRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildWebhookAccepted());
    bus.publish(buildJobStarted());
    bus.publish(buildJobFailed({ final: false }));
    expect(registry.list()).toEqual([]);

    bus.publish(buildJobStarted({ jobId: 'job-2', timestamp: 6 }));
    bus.publish(buildJobFailed({ jobId: 'job-2', timestamp: 7, final: true }));

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ jobId: 'job-2', outcome: 'failed', error: 'boom' });
  });

  it('records non-routing-match webhook rejections separately from real failures (excluded)', () => {
    const registry = new RecentCompletionsRegistry();
    registry.start();
    getEventBus().publish(buildWebhookRejected({ reason: 'no-routing-match' }));
    expect(registry.list()).toEqual([]);
  });

  it('records other webhook rejections (invalid signature, duplicate)', () => {
    const registry = new RecentCompletionsRegistry();
    registry.start();
    getEventBus().publish(buildWebhookRejected({ reason: 'invalid-signature' }));
    getEventBus().publish(buildWebhookRejected({ reason: 'duplicate', traceId: 'trace-3' }));

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.outcome).toBe('rejected');
    expect(list[0]?.reason).toBe('duplicate');
    expect(list[1]?.reason).toBe('invalid-signature');
  });

  it('drops oldest entries when the buffer overflows', () => {
    const registry = new RecentCompletionsRegistry(2);
    registry.start();
    const bus = getEventBus();

    for (let i = 1; i <= 4; i++) {
      bus.publish(buildJobStarted({ jobId: `job-${i}`, traceId: `trace-${i}` }));
      bus.publish(
        buildJobCompleted({ jobId: `job-${i}`, traceId: `trace-${i}`, timestamp: 100 + i }),
      );
    }

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.jobId)).toEqual(['job-4', 'job-3']);
  });

  it('orders entries newest-first', () => {
    const registry = new RecentCompletionsRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildJobStarted({ jobId: 'job-1', traceId: 'trace-1' }));
    bus.publish(buildJobCompleted({ jobId: 'job-1', traceId: 'trace-1', timestamp: 100 }));
    bus.publish(buildJobStarted({ jobId: 'job-2', traceId: 'trace-2' }));
    bus.publish(buildJobCompleted({ jobId: 'job-2', traceId: 'trace-2', timestamp: 200 }));

    const list = registry.list();
    expect(list.map((e) => e.jobId)).toEqual(['job-2', 'job-1']);
  });

  it('stop() unsubscribes and clears state', () => {
    const registry = new RecentCompletionsRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildJobStarted());
    bus.publish(buildJobCompleted());
    expect(registry.list()).toHaveLength(1);

    registry.stop();
    expect(registry.list()).toEqual([]);

    bus.publish(buildJobCompleted({ jobId: 'job-2', traceId: 'trace-2' }));
    expect(registry.list()).toEqual([]);
  });

  it('double-start and double-stop are no-ops', () => {
    const registry = new RecentCompletionsRegistry();
    registry.start();
    registry.start();
    getEventBus().publish(buildJobStarted());
    getEventBus().publish(buildJobCompleted());
    expect(registry.list()).toHaveLength(1);

    registry.stop();
    expect(() => registry.stop()).not.toThrow();
  });
});

describe('getRecentCompletionsRegistry singleton', () => {
  beforeEach(() => {
    resetEventBus();
    resetRecentCompletionsRegistry();
  });

  it('returns the same instance and subscribes on first call', () => {
    const a = getRecentCompletionsRegistry();
    const b = getRecentCompletionsRegistry();
    expect(a).toBe(b);

    getEventBus().publish(buildJobStarted());
    getEventBus().publish(buildJobCompleted());
    expect(a.list()).toHaveLength(1);
  });

  it('resetRecentCompletionsRegistry stops the instance and returns a fresh one', () => {
    const a = getRecentCompletionsRegistry();
    getEventBus().publish(buildJobStarted());
    getEventBus().publish(buildJobCompleted());
    expect(a.list()).toHaveLength(1);

    resetRecentCompletionsRegistry();
    const b = getRecentCompletionsRegistry();
    expect(a).not.toBe(b);
    expect(b.list()).toEqual([]);
  });
});
