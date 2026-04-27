import { createHash, randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';
import { z } from 'zod';

import type { WebhookProviderConfig } from '../config';
import type { ResolvedAgent } from '../services/agent-loader.service';
import { getEventBus } from '../services/event-bus.service';
import type { EventBus } from '../services/event-bus.service';
import { ingestEvent } from '../services/event-ingest.service';
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

function formatHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(',');
  return value ?? '';
}

function hashHeaders(headers: Request['headers']): string {
  const material = Object.entries(headers)
    .map(([k, v]) => `${k}:${formatHeaderValue(v)}`)
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
  provider: WebhookProviderConfig,
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
  provider: WebhookProviderConfig,
): boolean {
  const challengeParse = SlackChallengeSchema.safeParse(parsedPayload);
  if (!challengeParse.success) {
    return false;
  }
  logger.info({ provider: provider.name }, 'Slack URL verification challenge received');
  response.status(200).json({ challenge: challengeParse.data.challenge });
  return true;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function createWebhookHandler(
  provider: WebhookProviderConfig,
  agents: readonly ResolvedAgent[],
) {
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

    const rawBodyString = rawBody.toString('utf-8');
    const parsedPayload = tryParseJson(rawBodyString);

    if (handleSlackChallenge(parsedPayload, response, provider)) return;

    const result = await ingestEvent({
      provider,
      agents,
      rawBodyString,
      parsedPayload,
      traceId,
      events,
    });

    if (result.outcome === 'no-routing-match') {
      response.status(202).json({ accepted: true, routed: false });
      return;
    }
    if (result.outcome === 'duplicate') {
      response.status(202).json({ accepted: true, duplicate: true });
      return;
    }
    response.status(202).json({ accepted: true });
  };
}
