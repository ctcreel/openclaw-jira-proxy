import { getSettings } from '../config';
import {
  type ActiveJob,
  type ActiveJobContext,
  getActiveJobsRegistry,
} from './active-jobs.service';
import { getEventBus } from './event-bus.service';
import { getProviderQueue } from './queue.service';
import { type RecentCompletion, getRecentCompletionsRegistry } from './recent-completions.service';
import { parseEnvelope } from './worker.service';

const WAITING_PER_PROVIDER_LIMIT = 99;

export interface WaitingJob {
  jobId: string;
  provider: string;
  queuedAt: number;
  /**
   * Trace context extracted from the BullMQ envelope's `context` field
   * when present (set by event-ingest at first enqueue, preserved by
   * worker-failure-handler retries and quota-pause re-enqueues). Null
   * for legacy raw-body envelopes that predate the context-on-envelope
   * change. Lets the dashboard's bootstrap show real ticket id/title
   * for waiting rows instead of "?" until the next live event arrives.
   */
  context: ActiveJobContext | null;
}

export interface QueueSnapshot {
  active: ActiveJob[];
  waiting: WaitingJob[];
  recentlyCompleted: RecentCompletion[];
  /** Latest event id stamped on the bus when the snapshot was composed.
   *  Clients should pass this back as `Last-Event-ID` on the subsequent SSE
   *  connect so live events resume from exactly the right position.        */
  latestEventId: number;
}

/**
 * Composes the dashboard's bootstrap snapshot — one round trip seeds active,
 * waiting, and recent panels plus the SSE replay anchor. SPE-1976.
 *
 * Active and recentlyCompleted come from in-process registries (cheap,
 * synchronous reads). Waiting reads BullMQ across all configured providers
 * in parallel via Promise.all — the per-provider Redis round trips are
 * independent. `latestEventId` is captured AFTER the in-process reads so
 * any event that updated the registries is also covered by the replay
 * anchor; capturing it earlier would risk a tiny window where an in-memory
 * update lands between snapshot and id-capture, leaving the client unable
 * to resume from the right place.
 */
export async function buildQueueSnapshot(): Promise<QueueSnapshot> {
  const providers = getSettings().providers;

  const waitingPerProvider = await Promise.all(
    providers.map(async (provider) => collectWaiting(provider.name)),
  );
  const waiting = waitingPerProvider.flat();

  const active = getActiveJobsRegistry().listActive();
  const recentlyCompleted = getRecentCompletionsRegistry().list();
  const latestEventId = getEventBus().getLatestId();

  return {
    active,
    waiting,
    recentlyCompleted,
    latestEventId,
  };
}

async function collectWaiting(providerName: string): Promise<WaitingJob[]> {
  const queue = getProviderQueue(providerName);
  const jobs = await queue.getWaiting(0, WAITING_PER_PROVIDER_LIMIT);
  return jobs.map((job) => {
    const data = (job as { data?: string }).data;
    const context = extractContextFromJobData(data);
    return {
      jobId: String((job as { id?: string | number }).id ?? 'unknown'),
      provider: providerName,
      queuedAt: (job as { timestamp?: number }).timestamp ?? 0,
      context,
    };
  });
}

function extractContextFromJobData(data: string | undefined): ActiveJobContext | null {
  if (data === undefined) return null;
  // parseEnvelope handles both the legacy raw-body shape (returns
  // {payload, attempt} with no context) and the new envelope shape
  // (returns context when present). It catches its own JSON parse
  // errors and falls back to a first-attempt payload, so it never
  // throws on bad input — no try/catch needed here.
  const envelope = parseEnvelope(data);
  if (envelope.context === undefined) return null;
  return {
    id: envelope.context.id,
    title: envelope.context.title,
    status: envelope.context.status,
  };
}
