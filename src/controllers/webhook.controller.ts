import { createHash, randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';
import { z } from 'zod';

import type { ProviderConfig } from '../config';
import { getSettings } from '../config';
import type { ResolvedAgent } from '../services/agent-loader.service';
import { getDedupRedis } from '../services/dedup.service';
import { getEventBus } from '../services/event-bus.service';
import type { EventBus } from '../services/event-bus.service';
import { getProviderQueue } from '../services/queue.service';
import { extractWebhookContext } from '../strategies/context';
import type { WebhookContext } from '../strategies/context';
import { resolveAgentFromAgents } from '../strategies/routing';
import { getSignatureStrategy } from '../strategies/signature';
import type { SignatureStrategy } from '../strategies/signature';
import { getLogger } from '../lib/logging';

const logger = getLogger('webhook-controller');

/**
 * Slack Events API URL-verification challenge shape.
 *
 * Slack sends this once when a new Events subscription is registered; the
 * endpoint must echo back the `challenge` value. Modeled as a schema so
 * that matching the payload is a validated check rather than an `as` cast.
 */
const SlackChallengeSchema = z.object({
  type: z.literal('url_verification'),
  challenge: z.string(),
});

function hashHeaders(headers: Request['headers']): string {
  const material = Object.entries(headers)
    .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join(',') : String(v ?? '')}`)
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

function collectAdditionalHeaders(
  request: Request,
  strategy: SignatureStrategy,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!strategy.additionalHeaders) {
    return headers;
  }
  for (const name of strategy.additionalHeaders) {
    const value = request.headers[name];
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * Returns the raw body when signature verification passes, otherwise
 * returns null after sending a 401/500 response. Callers short-circuit
 * on null.
 */
function verifyRequestSignature(
  request: Request,
  response: Response,
  provider: ProviderConfig,
  strategy: SignatureStrategy,
  events: EventBus,
  traceId: string,
): Buffer | null {
  const signatureHeader = request.headers[strategy.headerName];
  if (typeof signatureHeader !== 'string') {
    logger.warn({ provider: provider.name }, `Missing ${strategy.headerName} header`);
    events.publish({
      type: 'webhook.rejected',
      timestamp: Date.now(),
      traceId,
      provider: provider.name,
      reason: 'missing-signature',
    });
    response.status(401).json({ error: 'Missing signature' });
    return null;
  }

  if (!provider.hmacSecret) {
    logger.error({ provider: provider.name }, 'No HMAC secret configured');
    response.status(500).json({ error: 'Provider misconfigured' });
    return null;
  }

  // Raw-body middleware (src/app.ts) should deliver a Buffer. A runtime
  // check here catches route-level misconfiguration instead of letting
  // HMAC validation fail against a stringified payload.
  if (!Buffer.isBuffer(request.body)) {
    logger.error(
      { provider: provider.name },
      'Webhook route is not configured with raw-body parser',
    );
    response.status(500).json({ error: 'Provider misconfigured' });
    return null;
  }
  const rawBody: Buffer = request.body;
  const additionalHeaders = collectAdditionalHeaders(request, strategy);

  if (!strategy.validate(rawBody, signatureHeader, provider.hmacSecret, additionalHeaders)) {
    logger.warn({ provider: provider.name }, 'Invalid HMAC signature');
    events.publish({
      type: 'webhook.rejected',
      timestamp: Date.now(),
      traceId,
      provider: provider.name,
      reason: 'invalid-signature',
    });
    response.status(401).json({ error: 'Invalid signature' });
    return null;
  }

  return rawBody;
}

/**
 * Returns true if the payload was a Slack URL-verification challenge and
 * the response has been sent. Callers short-circuit when true.
 */
function handleSlackChallenge(
  parsedPayload: unknown,
  response: Response,
  provider: ProviderConfig,
): boolean {
  const challengeParse = SlackChallengeSchema.safeParse(parsedPayload);
  if (!challengeParse.success) {
    return false;
  }
  logger.info({ provider: provider.name }, 'Slack URL verification challenge received');
  response.status(200).json({ challenge: challengeParse.data.challenge });
  return true;
}

/**
 * Dedup check. Returns true if this event is a duplicate (already handled
 * the response); false if the caller should proceed with enqueue.
 * Jira fires multiple webhooks per transition (status, assignee, rank);
 * only the first for a given ticket+status should be enqueued.
 */
async function handleDedup(
  provider: ProviderConfig,
  context: WebhookContext,
  traceId: string,
  events: EventBus,
  response: Response,
): Promise<boolean> {
  if (context.id === '?') {
    return false;
  }
  const dedupKey = `clawndom:dedup:${provider.name}:${context.id}:${context.status}`;
  const isNew = await getDedupRedis().set(dedupKey, '1', 'EX', getSettings().dedupTtlSeconds, 'NX');

  if (isNew !== null) {
    return false;
  }

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
  });
  response.status(202).json({ accepted: true, duplicate: true });
  return true;
}

async function enqueueWebhookEvent(
  provider: ProviderConfig,
  rawBody: Buffer,
  context: WebhookContext,
  events: EventBus,
): Promise<void> {
  const queue = getProviderQueue(provider.name);
  const job = await queue.add('webhook-event', rawBody.toString('utf-8'));

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
    'Webhook accepted and enqueued',
  );
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function createWebhookHandler(provider: ProviderConfig, agents: readonly ResolvedAgent[]) {
  const strategy = getSignatureStrategy(provider.signatureStrategy);

  return async (request: Request, response: Response): Promise<void> => {
    const traceId = randomUUID();
    const events = getEventBus();

    events.publish({
      type: 'webhook.received',
      timestamp: Date.now(),
      traceId,
      provider: provider.name,
      rawHeadersHash: hashHeaders(request.headers),
    });

    const rawBody = verifyRequestSignature(request, response, provider, strategy, events, traceId);
    if (rawBody === null) return;

    const parsedPayload = tryParseJson(rawBody.toString('utf-8'));

    if (handleSlackChallenge(parsedPayload, response, provider)) return;

    const context = extractWebhookContext(provider.name, parsedPayload);

    // Check routing BEFORE enqueueing — don't queue events that will be skipped
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
      });
      response.status(202).json({ accepted: true, routed: false });
      return;
    }

    if (await handleDedup(provider, context, traceId, events, response)) return;

    await enqueueWebhookEvent(provider, rawBody, context, events);
    response.status(202).json({ accepted: true });
  };
}
