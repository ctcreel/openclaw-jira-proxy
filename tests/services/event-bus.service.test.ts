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

describe('EventBus', () => {
  it('delivers published events to subscribers', () => {
    const bus = new EventBus();
    const received: ClawndomEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.publish(sampleEvent);

    expect(received).toEqual([sampleEvent]);
  });

  it('supports multiple subscribers independently', () => {
    const bus = new EventBus();
    const a: ClawndomEvent[] = [];
    const b: ClawndomEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.publish(sampleEvent);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('stops delivering to a subscriber after unsubscribe', () => {
    const bus = new EventBus();
    const received: ClawndomEvent[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));

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
