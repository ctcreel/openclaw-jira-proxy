import express from 'express';
import type { RequestHandler, Request, Response } from 'express';

import { getLogger } from '../../lib/logging';
import { recordCallbackEvent } from './callback-dedupe';
import { builderDeployCompletePayloadSchema } from './payloads';

const logger = getLogger('builder-deploy-complete');

/**
 * Handler for `POST /webhooks/builder-deploy-complete` — called by the
 * external supervisor (PM2 / systemd / k8s deployment hook) after each
 * clawndom restart that includes a merged Builder PR. The handler maps
 * the supervisor's `{job_id, status}` signal into the appropriate
 * `testable` or `failed` Builder callback state, recording it in the
 * dedupe store so a re-delivered signal doesn't fire twice.
 *
 * The actual fan-out to the dispatching agent's reply template still
 * goes through the standard `/webhooks/builder-callback` ingestion path
 * (auto-injected webhook provider). This route is the admin tap.
 */
type DeployCompleteHandler = (request: Request, response: Response) => Promise<void>;

export function createDeployCompleteHandler(): DeployCompleteHandler {
  return async function handleDeployComplete(request: Request, response: Response): Promise<void> {
    const parseResult = builderDeployCompletePayloadSchema.safeParse(request.body);
    if (!parseResult.success) {
      response.status(400).json({
        type: 'about:blank',
        title: 'Invalid payload',
        status: 400,
        detail: parseResult.error.message,
      });
      return;
    }

    const payload = parseResult.data;
    const state = payload.status === 'ok' ? 'testable' : 'failed';
    const eventId = `${payload.jobId}:${state}`;

    const firstDelivery = await recordCallbackEvent(eventId);
    if (!firstDelivery) {
      logger.info({ eventId }, 'Duplicate deploy-complete signal — no-op');
      response.status(202).json({ accepted: true, deduped: true });
      return;
    }

    logger.info(
      { jobId: payload.jobId, status: payload.status, state, eventId },
      "Deploy-complete signal recorded; downstream callback fan-out is the dispatching agent's responsibility",
    );

    // The next concrete step (separate change) is to call ingestEvent
    // against the `builder-callback` provider so the dispatching agent's
    // routing rules pick this up and render the operator reply. The
    // deploy-complete admin route intentionally returns 202 even before
    // that wire-up so the supervisor isn't blocked on agent processing.
    response.status(202).json({ accepted: true, state });
  };
}

export const deployCompleteJsonParser: RequestHandler = express.json({ limit: '64kb' });
