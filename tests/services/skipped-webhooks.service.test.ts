import { describe, it, expect, beforeEach } from 'vitest';

import {
  SkippedWebhooksRegistry,
  getSkippedWebhooksRegistry,
  resetSkippedWebhooksRegistry,
} from '../../src/services/skipped-webhooks.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import type { WebhookRejectedEvent } from '../../src/types/clawndom-event';

function buildRejected(overrides: Partial<WebhookRejectedEvent> = {}): WebhookRejectedEvent {
  return {
    type: 'webhook.rejected',
    timestamp: 1,
    traceId: 'trace-1',
    provider: 'jira',
    reason: 'no-routing-match',
    ...overrides,
  };
}

describe('SkippedWebhooksRegistry', () => {
  beforeEach(() => {
    resetEventBus();
    resetSkippedWebhooksRegistry();
  });

  it('starts empty', () => {
    const registry = new SkippedWebhooksRegistry();
    registry.start();
    expect(registry.listRecent()).toEqual([]);
    expect(registry.getCounts()).toEqual({
      noMatch: 0,
      duplicate: 0,
      signatureFailure: 0,
      senderGateRefusal: 0,
    });
  });

  it('records a no-routing-match rejection with full context', () => {
    const registry = new SkippedWebhooksRegistry();
    registry.start();

    getEventBus().publish(
      buildRejected({
        timestamp: 100,
        contextId: 'SPE-100',
        contextStatus: 'Backlog',
        contextTitle: 'Some ticket',
      }),
    );

    expect(registry.listRecent()).toEqual([
      {
        timestamp: 100,
        provider: 'jira',
        reason: 'no-routing-match',
        contextId: 'SPE-100',
        contextStatus: 'Backlog',
        contextTitle: 'Some ticket',
        traceId: 'trace-1',
      },
    ]);
    expect(registry.getCounts()).toEqual({
      noMatch: 1,
      duplicate: 0,
      signatureFailure: 0,
      senderGateRefusal: 0,
    });
  });

  it('partitions counts by reason — no-match, duplicate, signature failures, sender-gate refusals', () => {
    const registry = new SkippedWebhooksRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildRejected({ reason: 'no-routing-match', timestamp: 1 }));
    bus.publish(buildRejected({ reason: 'no-routing-match', timestamp: 2 }));
    bus.publish(buildRejected({ reason: 'duplicate', timestamp: 3 }));
    bus.publish(buildRejected({ reason: 'invalid-signature', timestamp: 4 }));
    bus.publish(buildRejected({ reason: 'missing-signature', timestamp: 5 }));
    bus.publish(buildRejected({ reason: 'sender-gate-refusal', timestamp: 6 }));

    expect(registry.getCounts()).toEqual({
      noMatch: 2,
      duplicate: 1,
      signatureFailure: 2,
      senderGateRefusal: 1,
    });
    expect(registry.listRecent()).toHaveLength(6);
  });

  it('returns most-recent-first ordering', () => {
    const registry = new SkippedWebhooksRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildRejected({ timestamp: 10, traceId: 'a' }));
    bus.publish(buildRejected({ timestamp: 20, traceId: 'b' }));
    bus.publish(buildRejected({ timestamp: 30, traceId: 'c' }));

    const recent = registry.listRecent();
    expect(recent.map((r) => r.traceId)).toEqual(['c', 'b', 'a']);
  });

  it('clamps listRecent(limit) to the requested number, server-clamped to cap', () => {
    const registry = new SkippedWebhooksRegistry({ capacity: 5 });
    registry.start();
    const bus = getEventBus();

    for (let i = 0; i < 5; i += 1) {
      bus.publish(buildRejected({ timestamp: i, traceId: `t-${i}` }));
    }

    expect(registry.listRecent(2)).toHaveLength(2);
    expect(registry.listRecent(0)).toHaveLength(0);
    // Negative or huge limits clamp to [0, capacity]
    expect(registry.listRecent(999)).toHaveLength(5);
    expect(registry.listRecent(-1)).toHaveLength(0);
  });

  it('drops oldest entries when capacity is exceeded', () => {
    const registry = new SkippedWebhooksRegistry({ capacity: 3 });
    registry.start();
    const bus = getEventBus();

    bus.publish(buildRejected({ timestamp: 1, traceId: 't-1' }));
    bus.publish(buildRejected({ timestamp: 2, traceId: 't-2' }));
    bus.publish(buildRejected({ timestamp: 3, traceId: 't-3' }));
    bus.publish(buildRejected({ timestamp: 4, traceId: 't-4' }));

    const recent = registry.listRecent();
    expect(recent.map((r) => r.traceId)).toEqual(['t-4', 't-3', 't-2']);
    // Counts are cumulative, NOT bounded by ring size — they reflect total
    // observed rejections, even after older entries fall out of the ring.
    expect(registry.getCounts().noMatch).toBe(4);
  });

  it('ignores non-rejection events', () => {
    const registry = new SkippedWebhooksRegistry();
    registry.start();
    getEventBus().publish({
      type: 'webhook.received',
      timestamp: 1,
      traceId: 'x',
      provider: 'jira',
      rawHeadersHash: 'abc',
    });
    expect(registry.listRecent()).toEqual([]);
    expect(registry.getCounts()).toEqual({
      noMatch: 0,
      duplicate: 0,
      signatureFailure: 0,
      senderGateRefusal: 0,
    });
  });

  it('stop() unsubscribes and clears state', () => {
    const registry = new SkippedWebhooksRegistry();
    registry.start();
    const bus = getEventBus();

    bus.publish(buildRejected());
    expect(registry.listRecent()).toHaveLength(1);

    registry.stop();
    expect(registry.listRecent()).toEqual([]);
    expect(registry.getCounts()).toEqual({
      noMatch: 0,
      duplicate: 0,
      signatureFailure: 0,
      senderGateRefusal: 0,
    });

    bus.publish(buildRejected({ traceId: 't-2' }));
    expect(registry.listRecent()).toEqual([]);
  });

  it('double-start is a no-op (single subscription)', () => {
    const registry = new SkippedWebhooksRegistry();
    registry.start();
    registry.start();
    getEventBus().publish(buildRejected());
    // Without dedupe, two subscriptions would record the event twice.
    expect(registry.listRecent()).toHaveLength(1);
  });

  it('double-stop is a no-op', () => {
    const registry = new SkippedWebhooksRegistry();
    registry.start();
    registry.stop();
    expect(() => registry.stop()).not.toThrow();
  });
});

describe('getSkippedWebhooksRegistry singleton', () => {
  beforeEach(() => {
    resetEventBus();
    resetSkippedWebhooksRegistry();
  });

  it('returns the same instance and subscribes on first call', () => {
    const a = getSkippedWebhooksRegistry();
    const b = getSkippedWebhooksRegistry();
    expect(a).toBe(b);

    getEventBus().publish(buildRejected());
    expect(a.listRecent()).toHaveLength(1);
  });

  it('resetSkippedWebhooksRegistry stops the instance and returns a fresh one', () => {
    const a = getSkippedWebhooksRegistry();
    getEventBus().publish(buildRejected());
    expect(a.listRecent()).toHaveLength(1);

    resetSkippedWebhooksRegistry();
    const b = getSkippedWebhooksRegistry();
    expect(a).not.toBe(b);
    expect(b.listRecent()).toEqual([]);
  });
});
