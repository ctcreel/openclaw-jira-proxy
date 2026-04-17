import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';

import type { ProviderConfig } from '../config';
import type { ResolvedAgent } from '../services/agent-loader.service';
import { getDedupRedis } from '../services/dedup.service';
import { getEventBus } from '../services/event-bus.service';
import { getProviderQueue } from '../services/queue.service';
import { extractWebhookContext } from '../strategies/context';
import { resolveAgentFromAgents } from '../strategies/routing';
import { getSignatureStrategy } from '../strategies/signature';
import { getLogger } from '../lib/logging';

const logger = getLogger('webhook-controller');

/**
 * Dedup window in seconds. Jira fires multiple webhooks per transition
 * (status, assignee, rank) within ~2 seconds. A short TTL catches the burst
 * without blocking legitimate retries or replays.
 */
const DEDUP_TTL_SECONDS = 10;

function hashHeaders(headers: Request['headers']): string {
  const material = Object.entries(headers)
    .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join(',') : (v ?? '')}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

export function createWebhookHandler(provider: ProviderConfig, agents: readonly ResolvedAgent[]) {
  const strategy = getSignatureStrategy(provider.signatureStrategy);

  return async (request: Request, response: Response): Promise<void> => {
    const traceId = randomUUID();
    const events = getEventBus();
    const rawHeadersHash = hashHeaders(request.headers);

    events.publish({
      type: 'webhook.received',
      timestamp: Date.now(),
      traceId,
      provider: provider.name,
      rawHeadersHash,
    });

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
      // DEBUG(SPE-1703): temporary diagnostic — strip after HMAC root cause identified.
      const expectedSha256 = createHmac('sha256', provider.hmacSecret)
        .update(rawBody)
        .digest('hex');
      const expectedSha1 = createHmac('sha1', provider.hmacSecret).update(rawBody).digest('hex');
      const bodyPreview = rawBody.toString('utf-8').slice(0, 120);
      const jiraHeaders: Record<string, string> = {};
      for (const name of Object.keys(request.headers)) {
        if (
          name.toLowerCase().startsWith('x-') ||
          name === 'content-type' ||
          name === 'user-agent'
        ) {
          const value = request.headers[name];
          jiraHeaders[name] = Array.isArray(value) ? value.join(',') : (value ?? '');
        }
      }
      logger.warn(
        {
          provider: provider.name,
          receivedSignature: signatureHeader,
          expectedSha256,
          expectedSha1,
          bodyLength: rawBody.length,
          bodyPreview,
          secretPrefix: provider.hmacSecret.slice(0, 8),
          jiraHeaders,
        },
        'Invalid HMAC signature [DIAGNOSTIC]',
      );
      events.publish({
        type: 'webhook.rejected',
        timestamp: Date.now(),
        traceId,
        provider: provider.name,
        reason: 'invalid-signature',
      });
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
    const resolved = resolveAgentFromAgents(parsedPayload, provider.name, agents);

    if (resolved === null) {
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
        events.publish({
          type: 'webhook.rejected',
          timestamp: Date.now(),
          traceId,
          provider: provider.name,
          reason: 'duplicate',
        });
        response.status(202).json({ accepted: true, duplicate: true });
        return;
      }
    }

    const queue = getProviderQueue(provider.name);
    const job = await queue.add('webhook-event', rawBody.toString('utf-8'));

    events.publish({
      type: 'webhook.accepted',
      timestamp: Date.now(),
      traceId,
      provider: provider.name,
      contextId: context.id,
      contextTitle: context.title,
      contextStatus: context.status,
    });

    events.publish({
      type: 'job.queued',
      timestamp: Date.now(),
      traceId,
      jobId: String(job.id ?? 'unknown'),
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
    response.status(202).json({ accepted: true });
  };
}
