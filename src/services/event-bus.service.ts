import { EventEmitter } from 'node:events';

import type { ClawndomEvent } from '../types/clawndom-event';

/**
 * In-process pub/sub for Clawndom events. One EventBus per server process.
 *
 * Each published event is stamped with a strictly-monotonic `id` and pushed
 * onto a bounded ring buffer; subscribers receive the stamped envelope.
 * `unsubscribe()` is idempotent — safe to call after client disconnect,
 * after server shutdown, or both.
 *
 * The id + buffer + `subscribeSince` triad is the WHATWG SSE replay contract
 * (`Last-Event-ID` header / `id:` frame line). Without it, any subscriber
 * that misses a window — including the dashboard during a brief restart or
 * a silent SSE drop — is silently desynced. SPE-1976.
 */
export interface StampedEvent {
  readonly id: number;
  readonly event: ClawndomEvent;
}

export interface ReplaySlice {
  /** Buffered events with id strictly greater than the requested sinceId. */
  readonly events: readonly StampedEvent[];
  /** Latest id stamped on the bus at the moment the slice was captured. */
  readonly latestId: number;
  /**
   * True when the requested sinceId is older than the buffer's oldest entry,
   * so the replay is incomplete. Consumers should re-bootstrap from the
   * snapshot endpoint rather than treat the partial replay as canonical.
   */
  readonly gap: boolean;
}

export interface SubscribeSinceResult {
  readonly replayed: readonly StampedEvent[];
  readonly latestId: number;
  readonly gap: boolean;
  readonly unsubscribe: () => void;
}

const DEFAULT_BUFFER_SIZE = 500;
const ENV_BUFFER_SIZE_KEY = 'EVENT_REPLAY_BUFFER_SIZE';

function resolveBufferSize(explicit?: number): number {
  if (explicit !== undefined) {
    return Math.max(1, explicit);
  }
  const raw = process.env[ENV_BUFFER_SIZE_KEY];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_BUFFER_SIZE;
}

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly bufferSize: number;
  private readonly buffer: StampedEvent[] = [];
  private nextId = 1;

  /**
   * @param bufferSize  Max number of events retained for replay. When unset,
   *                    falls back to the `EVENT_REPLAY_BUFFER_SIZE` env var,
   *                    then to a default of 500. The right value is a function
   *                    of event rate × expected reconnect window: a single busy
   *                    agent run can emit ~300 events, so 500 covers ~one run
   *                    of slack on a 60s soft-drop. Long-running multi-agent
   *                    activity may need a higher value to avoid `gap: true`
   *                    forcing snapshot re-bootstraps.
   */
  constructor(bufferSize?: number) {
    this.emitter.setMaxListeners(0);
    this.bufferSize = resolveBufferSize(bufferSize);
  }

  publish(event: ClawndomEvent): StampedEvent {
    const stamped: StampedEvent = { id: this.nextId++, event };
    this.buffer.push(stamped);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }
    this.emitter.emit('event', stamped);
    return stamped;
  }

  subscribe(handler: (stamped: StampedEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => {
      this.emitter.off('event', handler);
    };
  }

  /**
   * Returns events with id strictly greater than `sinceId`, the latest id
   * known to the bus, and a `gap` flag. Pure function of bus state.
   *
   * Semantics: callers that want "no replay" should pass `getLatestId()` —
   * see the controller's `Last-Event-ID`-missing branch. `replaySince(0)`
   * is "everything from id 1 onward" because event ids start at 1.
   *
   * `gap` is true when `sinceId` is older than the id immediately before
   * the buffer's head, meaning at least one event has been overwritten.
   * Negative `sinceId` is treated as 0 (everything).
   */
  replaySince(sinceId: number): ReplaySlice {
    const latestId = this.nextId - 1;
    const normalizedSince = Math.max(0, sinceId);
    if (this.buffer.length === 0) {
      return { events: [], latestId, gap: false };
    }
    // The first entry's id minus one is the highest id the buffer has lost.
    // Caller has id=N; the buffer can deliver everything strictly after N
    // only if N >= (oldestId - 1) — i.e. N either equals the id immediately
    // before the buffer head, or sits inside the buffer.
    const oldestId = this.buffer[0]!.id;
    const gap = normalizedSince < oldestId - 1;
    const events = this.buffer.filter((e) => e.id > normalizedSince);
    return { events, latestId, gap };
  }

  /**
   * Atomic replay + subscribe. Captures the buffer slice and attaches the
   * live subscriber in one synchronous block, with no awaits between. Live
   * events arriving after attach reach `handler` exactly once; events in
   * `replayed` have ids strictly less than every live event the handler
   * will see. Use this in preference to calling `replaySince` then
   * `subscribe` — the discipline of "no await between them" is fragile to
   * future maintenance, and breaking it causes silent event loss across the
   * replay/subscribe boundary.
   */
  subscribeSince(sinceId: number, handler: (stamped: StampedEvent) => void): SubscribeSinceResult {
    const slice = this.replaySince(sinceId);
    const unsubscribe = this.subscribe(handler);
    return {
      replayed: slice.events,
      latestId: slice.latestId,
      gap: slice.gap,
      unsubscribe,
    };
  }

  getLatestId(): number {
    return this.nextId - 1;
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
