import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

import { getSettings } from '../config';
import { getQueue } from '../services/queue.service';
import { getLogger } from '../lib/logging';

const logger = getLogger('webhook-controller');

function validateSignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) {
    return false;
  }

  const receivedHex = signatureHeader.slice(expectedPrefix.length);
  const computedHex = createHmac('sha256', secret).update(rawBody).digest('hex');

  const receivedBuffer = Buffer.from(receivedHex, 'hex');
  const computedBuffer = Buffer.from(computedHex, 'hex');

  if (receivedBuffer.length !== computedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, computedBuffer);
}

/**
 * Generate a stable job ID from the payload to prevent duplicate enqueues.
 *
 * Jira retries webhook deliveries on 5xx / timeout.  Using a content hash
 * as the BullMQ job ID means the second delivery is silently de-duplicated.
 */
function generateJobId(rawBody: Buffer): string {
  return `jira-${createHash('sha256').update(rawBody).digest('hex').slice(0, 16)}`;
}

export async function receiveWebhook(request: Request, response: Response): Promise<void> {
  const settings = getSettings();
  // Jira Cloud sends X-Hub-Signature (WebSub format), not X-Hub-Signature-256 (GitHub format)
  const signatureHeader = request.headers['x-hub-signature'];

  if (typeof signatureHeader !== 'string') {
    logger.warn('Missing X-Hub-Signature header');
    response.status(401).json({ error: 'Missing signature' });
    return;
  }

  const rawBody = request.body as Buffer;

  if (!validateSignature(rawBody, signatureHeader, settings.jiraHmacSecret)) {
    const computedHex = createHmac('sha256', settings.jiraHmacSecret).update(rawBody).digest('hex');
    logger.warn(
      {
        receivedSig: signatureHeader,
        computedSig: `sha256=${computedHex}`,
        bodyLength: rawBody.length,
        secretPrefix: settings.jiraHmacSecret.slice(0, 8),
      },
      'Invalid HMAC signature',
    );
    response.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const queue = getQueue();
  const jobId = generateJobId(rawBody);

  await queue.add('jira-event', rawBody.toString('utf-8'), { jobId });

  logger.info({ jobId }, 'Webhook accepted and enqueued');
  response.status(202).json({ accepted: true });
}
