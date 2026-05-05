/**
 * Shared ingest pipeline used by every Transport.
 *
 * Owns the steps that live BELOW signature/transport handling but ABOVE
 * the BullMQ worker: routing match, dedup, queue.add, and EventBus
 * publishes for `webhook.accepted` / `webhook.rejected` / `job.queued`.
 *
 * The webhook controller (HTTP) and the slack-socket transport call this
 * helper instead of reimplementing the same enqueue path. Single source
 * of truth — adding a third Transport later inherits dedup/routing
 * behavior for free, with no risk of drift between the two paths.
 */
import type { ProviderConfig } from '../config';
import { getSettings } from '../config';
import type { ResolvedAgent } from './agent-loader.service';
import { getDedupRedis } from './dedup.service';
import type { EventBus } from './event-bus.service';
import { getProviderQueue } from './queue.service';
import { extractWebhookContext } from '../strategies/context';
import { resolveAgentFromAgents } from '../strategies/routing';
import { getLogger } from '../lib/logging';

const logger = getLogger('event-ingest');

export interface IngestRequest {
  readonly provider: ProviderConfig;
  readonly agents: readonly ResolvedAgent[];
  /** The exact string the worker will JSON.parse. */
  readonly rawBodyString: string;
  /** Pre-parsed payload (callers usually parsed it already for challenge/signature checks). */
  readonly parsedPayload: unknown;
  /** Trace id created at the transport boundary; reused until BullMQ assigns a job id. */
  readonly traceId: string;
  readonly events: EventBus;
}

export type IngestResult =
  | { readonly outcome: 'no-routing-match' }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'enqueued'; readonly jobTraceId: string };

// noqa: NAMING001 — `ingest` is a transitive verb; the naming script's allowlist doesn't recognize it
export async function ingestEvent(request: IngestRequest): Promise<IngestResult> {
  const { provider, agents, rawBodyString, parsedPayload, traceId, events } = request;

  const context = extractWebhookContext(provider, parsedPayload);

  if (resolveAgentFromAgents(parsedPayload, provider.name, agents) === null) {
    logger.info(
      { provider: provider.name, contextId: context.id, contextStatus: context.status },
      'No routing match — not enqueueing',
    );
    events.publish({
      type: 'webhook.rejected',
      timestamp: Date.now(),
      traceId,
      provider: provider.name,
      reason: 'no-routing-match',
      contextId: context.id,
      contextStatus: context.status,
      contextTitle: context.title,
    });
    return { outcome: 'no-routing-match' };
  }

  if (context.id !== '?') {
    const dedupKey = `clawndom:dedup:${provider.name}:${context.id}:${context.status}`;
    const isNew = await getDedupRedis().set(
      dedupKey,
      '1',
      'EX',
      getSettings().dedupTtlSeconds,
      'NX',
    );
    if (isNew === null) {
      logger.info(
        { provider: provider.name, contextId: context.id, contextStatus: context.status },
        'Duplicate — already enqueued, skipping',
      );
      events.publish({
        type: 'webhook.rejected',
        timestamp: Date.now(),
        traceId,
        provider: provider.name,
        reason: 'duplicate',
        contextId: context.id,
        contextStatus: context.status,
        contextTitle: context.title,
      });
      return { outcome: 'duplicate' };
    }
  }

  // Persist context onto the BullMQ payload so it survives a clawndom
  // restart between enqueue and worker pickup. Without this, the in-process
  // pendingContext map dies with the prior process and the worker's
  // job.started fires with no context — /api/jobs/active then returns
  // context: null and the dashboard renders "?" for ticket id and status.
  const queue = getProviderQueue(provider.name);
  const envelope = JSON.stringify({
    payload: rawBodyString,
    attempt: 1,
    context: {
      id: context.id,
      title: context.title,
      status: context.status,
    },
  });
  const job = await queue.add('webhook-event', envelope);

  // After enqueue, the BullMQ job id becomes the canonical trace id —
  // the worker uses `envelope.originalJobId ?? jobIdString`, which on
  // the first attempt is exactly this job id. Dashboard handlers key
  // trace_context by traceId, so webhook.accepted and every subsequent
  // worker/runner event must share one value or the context lookup
  // misses and completed rows render as "?"/"?".
  const jobTraceId = String(job.id ?? 'unknown');

  events.publish({
    type: 'webhook.accepted',
    timestamp: Date.now(),
    traceId: jobTraceId,
    provider: provider.name,
    contextId: context.id,
    contextTitle: context.title,
    contextStatus: context.status,
  });
  events.publish({
    type: 'job.queued',
    timestamp: Date.now(),
    traceId: jobTraceId,
    jobId: jobTraceId,
    provider: provider.name,
    contextId: context.id,
    contextTitle: context.title,
  });

  logger.info(
    {
      provider: provider.name,
      contextId: context.id,
      contextStatus: context.status,
      contextTitle: context.title,
    },
    'Event accepted and enqueued',
  );

  return { outcome: 'enqueued', jobTraceId };
}
