import type { Request, Response } from 'express';

import type { ProviderConfig } from '../config';
import { getSettings } from '../config';
import { getDedupRedis } from '../services/dedup.service';
import { getProviderQueue } from '../services/queue.service';
import { extractWebhookContext } from '../strategies/context';
import { resolveAgent } from '../strategies/routing';
import { getSignatureStrategy } from '../strategies/signature';
import { getLogger } from '../lib/logging';

const logger = getLogger('webhook-controller');

/**
 * Dedup window in seconds. Jira fires multiple webhooks per transition
 * (status, assignee, rank) within ~2 seconds. A short TTL catches the burst
 * without blocking legitimate retries or replays.
 */
const DEDUP_TTL_SECONDS = 10;

export function createWebhookHandler(provider: ProviderConfig) {
  const strategy = getSignatureStrategy(provider.signatureStrategy);

  return async (request: Request, response: Response): Promise<void> => {
    const signatureHeader = request.headers[strategy.headerName];

    if (typeof signatureHeader !== 'string') {
      logger.warn({ provider: provider.name }, `Missing ${strategy.headerName} header`);
      response.status(401).json({ error: 'Missing signature' });
      return;
    }

    const rawBody = request.body as Buffer;

    const additionalHeaders: Record<string, string> = {};
    if (strategy.additionalHeaders) {
      for (const name of strategy.additionalHeaders) {
        const value = request.headers[name];
        if (typeof value === 'string') {
          additionalHeaders[name] = value;
        }
      }
    }

    if (!provider.hmacSecret) {
      logger.error({ provider: provider.name }, 'No HMAC secret configured');
      response.status(500).json({ error: 'Provider misconfigured' });
      return;
    }

    if (!strategy.validate(rawBody, signatureHeader, provider.hmacSecret, additionalHeaders)) {
      logger.warn({ provider: provider.name }, 'Invalid HMAC signature');
      response.status(401).json({ error: 'Invalid signature' });
      return;
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      parsedPayload = {};
    }

    // Slack Events API URL verification challenge
    if (
      typeof parsedPayload === 'object' &&
      parsedPayload !== null &&
      'type' in parsedPayload &&
      (parsedPayload as Record<string, unknown>).type === 'url_verification' &&
      'challenge' in parsedPayload
    ) {
      const challenge = (parsedPayload as Record<string, unknown>).challenge;
      logger.info({ provider: provider.name }, 'Slack URL verification challenge received');
      response.status(200).json({ challenge });
      return;
    }

    const context = extractWebhookContext(provider.name, parsedPayload);

    // Check routing BEFORE enqueueing — don't queue events that will be skipped
    const settings = getSettings();
    const resolved = resolveAgent(parsedPayload, provider.routing, settings.openclawAgentId);

    if (resolved === null) {
      logger.info(
        { provider: provider.name, contextId: context.id, contextStatus: context.status },
        'No routing match — not enqueueing',
      );
      response.status(202).json({ accepted: true, routed: false });
      return;
    }

    // Dedup: same ticket + same status within the TTL window = skip.
    // Jira fires multiple webhooks per transition (status, assignee, rank).
    // Only the first one for a given ticket+status should be enqueued.
    if (context.id !== '?') {
      const dedupKey = `clawndom:dedup:${provider.name}:${context.id}:${context.status}`;
      const isNew = await getDedupRedis().set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');

      if (isNew === null) {
        logger.info(
          { provider: provider.name, contextId: context.id, contextStatus: context.status },
          'Duplicate — already enqueued, skipping',
        );
        response.status(202).json({ accepted: true, duplicate: true });
        return;
      }
    }

    const queue = getProviderQueue(provider.name);
    await queue.add('webhook-event', rawBody.toString('utf-8'));

    logger.info(
      {
        provider: provider.name,
        contextId: context.id,
        contextStatus: context.status,
        contextTitle: context.title,
      },
      'Webhook accepted and enqueued',
    );
    response.status(202).json({ accepted: true });
  };
}
