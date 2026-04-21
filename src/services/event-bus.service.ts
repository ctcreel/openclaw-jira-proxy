import { EventEmitter } from 'node:events';

import type { ClawndomEvent } from '../types/clawndom-event';

/**
 * In-process pub/sub for Clawndom events. One EventBus per server process.
 *
 * Subscribers receive every event; filtering is the consumer's job.
 * `unsubscribe()` is idempotent — safe to call after client disconnect,
 * after server shutdown, or both.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Subscribers are long-lived (one per SSE client); 0 is the Node default
    // warning threshold, which would spam logs for a multi-client dashboard.
    this.emitter.setMaxListeners(0);
  }

  publish(event: ClawndomEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(handler: (event: ClawndomEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => {
      this.emitter.off('event', handler);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}

let instance: EventBus | null = null;

export function getEventBus(): EventBus {
  instance ??= new EventBus();
  return instance;
}

export function resetEventBus(): void {
  instance = null;
}
