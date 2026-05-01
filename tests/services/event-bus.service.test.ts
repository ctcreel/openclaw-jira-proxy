import { describe, it, expect, beforeEach } from 'vitest';

import { EventBus, getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import type { ClawndomEvent } from '../../src/types/clawndom-event';

const sampleEvent: ClawndomEvent = {
  type: 'webhook.received',
  timestamp: 1,
  traceId: 't-1',
  provider: 'jira',
  rawHeadersHash: 'abc',
};

function makeEvent(overrides: Partial<ClawndomEvent> = {}): ClawndomEvent {
  return { ...sampleEvent, ...overrides } as ClawndomEvent;
}

describe('EventBus', () => {
  it('delivers published events to subscribers', () => {
    const bus = new EventBus();
    const received: ClawndomEvent[] = [];
    bus.subscribe((stamped) => received.push(stamped.event));

    bus.publish(sampleEvent);

    expect(received).toEqual([sampleEvent]);
  });

  it('supports multiple subscribers independently', () => {
    const bus = new EventBus();
    const a: ClawndomEvent[] = [];
    const b: ClawndomEvent[] = [];
    bus.subscribe((s) => a.push(s.event));
    bus.subscribe((s) => b.push(s.event));

    bus.publish(sampleEvent);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('stops delivering to a subscriber after unsubscribe', () => {
    const bus = new EventBus();
    const received: ClawndomEvent[] = [];
    const unsubscribe = bus.subscribe((s) => received.push(s.event));

    bus.publish(sampleEvent);
    unsubscribe();
    bus.publish(sampleEvent);

    expect(received).toHaveLength(1);
  });

  it('double-unsubscribe is a no-op', () => {
    const bus = new EventBus();
    const unsubscribe = bus.subscribe(() => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('tracks listener count', () => {
    const bus = new EventBus();
    expect(bus.listenerCount()).toBe(0);
    const off = bus.subscribe(() => {});
    expect(bus.listenerCount()).toBe(1);
    off();
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('EventBus id stamping and replay buffer (SPE-1976)', () => {
  it('stamps strictly monotonic ids starting at 1 on a fresh bus', () => {
    const bus = new EventBus();
    const ids: number[] = [];
    bus.subscribe((s) => ids.push(s.id));

    bus.publish(sampleEvent);
    bus.publish(sampleEvent);
    bus.publish(sampleEvent);

    expect(ids).toEqual([1, 2, 3]);
  });

  it('reports the latest id as 0 when no events have been published', () => {
    const bus = new EventBus();
    expect(bus.getLatestId()).toBe(0);
  });

  it('reports the latest id as the most recently stamped event', () => {
    const bus = new EventBus();
    bus.publish(sampleEvent);
    bus.publish(sampleEvent);
    expect(bus.getLatestId()).toBe(2);
  });

  it('drops oldest entries when the ring buffer overflows', () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i++) bus.publish(sampleEvent);

    const slice = bus.replaySince(0);
    expect(slice.events.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(slice.latestId).toBe(5);
  });

  it('replaySince(0) returns the whole buffer with no gap', () => {
    const bus = new EventBus(10);
    bus.publish(sampleEvent);
    bus.publish(sampleEvent);

    const slice = bus.replaySince(0);
    expect(slice.events.map((e) => e.id)).toEqual([1, 2]);
    expect(slice.gap).toBe(false);
  });

  it('replaySince(latestId) returns no events', () => {
    const bus = new EventBus(10);
    bus.publish(sampleEvent);
    bus.publish(sampleEvent);

    const slice = bus.replaySince(2);
    expect(slice.events).toEqual([]);
    expect(slice.gap).toBe(false);
    expect(slice.latestId).toBe(2);
  });

  it('normalizes negative sinceId to 0 — full replay from id=1', () => {
    const bus = new EventBus(10);
    bus.publish(sampleEvent);

    // Negative sinceId is clamped to 0, which means "everything from id 1
    // onward". Callers that want "no replay" should pass `getLatestId()`.
    expect(bus.replaySince(-1)).toEqual({
      events: [{ id: 1, event: sampleEvent }],
      latestId: 1,
      gap: false,
    });
    expect(bus.replaySince(0)).toEqual({
      events: [{ id: 1, event: sampleEvent }],
      latestId: 1,
      gap: false,
    });
  });

  it('signals gap=true when sinceId is older than the buffer head', () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i++) bus.publish(sampleEvent);
    // Buffer holds ids 3,4,5. Caller asks for everything after id=1.
    // Events 2 was overwritten — partial replay, dashboard should re-bootstrap.
    const slice = bus.replaySince(1);
    expect(slice.gap).toBe(true);
    expect(slice.events.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it('does NOT signal gap when sinceId equals the id immediately before buffer head', () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i++) bus.publish(sampleEvent);
    // Buffer holds 3,4,5. sinceId=2 means "I have id 2, give me 3+" — no events lost.
    const slice = bus.replaySince(2);
    expect(slice.gap).toBe(false);
    expect(slice.events.map((e) => e.id)).toEqual([3, 4, 5]);
  });

  it('honors EVENT_REPLAY_BUFFER_SIZE env var when no constructor arg is given', () => {
    const original = process.env['EVENT_REPLAY_BUFFER_SIZE'];
    process.env['EVENT_REPLAY_BUFFER_SIZE'] = '2';
    try {
      const bus = new EventBus();
      bus.publish(sampleEvent);
      bus.publish(sampleEvent);
      bus.publish(sampleEvent);
      const slice = bus.replaySince(0);
      expect(slice.events.map((e) => e.id)).toEqual([2, 3]);
    } finally {
      if (original === undefined) delete process.env['EVENT_REPLAY_BUFFER_SIZE'];
      else process.env['EVENT_REPLAY_BUFFER_SIZE'] = original;
    }
  });
});

describe('EventBus.subscribeSince — atomic replay+attach (SPE-1976)', () => {
  it('returns the buffered slice and attaches a live subscriber atomically', () => {
    const bus = new EventBus(10);
    bus.publish(makeEvent({ traceId: 't-1' }));
    bus.publish(makeEvent({ traceId: 't-2' }));

    const live: number[] = [];
    const result = bus.subscribeSince(0, (s) => live.push(s.id));

    expect(result.replayed.map((e) => e.id)).toEqual([1, 2]);
    expect(result.latestId).toBe(2);
    expect(result.gap).toBe(false);
    expect(bus.listenerCount()).toBe(1);

    bus.publish(makeEvent({ traceId: 't-3' }));
    expect(live).toEqual([3]);

    result.unsubscribe();
    expect(bus.listenerCount()).toBe(0);
  });

  it('regression: a publish that lands AFTER subscribeSince attach is delivered live exactly once', () => {
    // The bug class this guards: a future maintainer adding an `await` between
    // replaySince() and subscribe() would let a publish slip through the gap,
    // buffered for future replay but never delivered to the just-attached
    // subscriber. Encapsulating both in subscribeSince() prevents that — and
    // this test pins the contract.
    const bus = new EventBus(10);
    bus.publish(sampleEvent);

    const live: number[] = [];
    const { replayed } = bus.subscribeSince(0, (s) => live.push(s.id));

    bus.publish(sampleEvent);

    expect(replayed.map((e) => e.id)).toEqual([1]);
    expect(live).toEqual([2]);
  });

  it('regression: a publish during the subscribeSince call is never duplicated to the new subscriber', () => {
    // If the implementation accidentally fires the live subscriber on events
    // already returned in `replayed`, the same event would be processed twice
    // by the dashboard. This pins the no-duplicate invariant by re-emitting
    // through a chained subscriber that publishes during attach.
    const bus = new EventBus(10);
    bus.publish(sampleEvent);

    const captured: number[] = [];
    // First subscriber that re-publishes once when it sees the seed event.
    let republished = false;
    bus.subscribe((s) => {
      if (!republished && s.id === 1) {
        republished = true;
        bus.publish(sampleEvent);
      }
    });

    const live: number[] = [];
    const { replayed } = bus.subscribeSince(0, (s) => {
      captured.push(s.id);
      live.push(s.id);
    });

    expect(replayed.map((e) => e.id)).toEqual([1]);
    // The live handler should see only events published AFTER attach.
    // Since the chained subscriber only fires on id=1 (which it already saw
    // before subscribeSince ran), no live event is emitted here.
    expect(live).toEqual([]);

    bus.publish(sampleEvent);
    expect(live).toEqual([2]);
    expect(captured.length).toBe(1);
  });

  it('signals gap when sinceId is older than the buffer can replay', () => {
    const bus = new EventBus(2);
    for (let i = 0; i < 5; i++) bus.publish(sampleEvent);
    // Buffer holds ids 4,5. Caller has id=1, so events 2,3 are lost.
    const result = bus.subscribeSince(1, () => {});
    expect(result.gap).toBe(true);
    expect(result.replayed.map((e) => e.id)).toEqual([4, 5]);
  });
});

describe('getEventBus singleton', () => {
  beforeEach(() => {
    resetEventBus();
  });

  it('returns the same instance across calls', () => {
    const a = getEventBus();
    const b = getEventBus();
    expect(a).toBe(b);
  });

  it('resetEventBus creates a fresh instance', () => {
    const a = getEventBus();
    resetEventBus();
    const b = getEventBus();
    expect(a).not.toBe(b);
  });
});
