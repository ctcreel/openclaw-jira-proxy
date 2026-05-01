import express from 'express';
import type { Express } from 'express';

import { createHealthRoutes } from './health.routes';
import { getSettings, isWebhookProvider } from '../config';
import { handleEventStream } from '../controllers/events.controller';
import { listActiveJobs } from '../controllers/active-jobs.controller';
import { listRecentSkippedWebhooks } from '../controllers/skipped-webhooks.controller';
import { handleQueueSnapshot } from '../controllers/queue-snapshot.controller';
import {
  createTaskHandler,
  getTaskStatusHandler,
  waitTaskHandler,
} from '../controllers/task.controller';
import type { ResolvedAgent } from '../services/agent-loader.service';
import { WebhookTransport } from '../strategies/transport';

/**
 * Registers the always-on framework routes (health, events stream, task
 * API) plus an HTTP webhook route per `transport: 'webhook'` provider.
 *
 * `transport: 'slack-socket'` providers don't get an HTTP route — they
 * start an outbound websocket via `startTransports` in `server.ts` after
 * secrets resolve.
 */
export function registerRoutes(app: Express, agents: readonly ResolvedAgent[]): void {
  app.use('/api/health', createHealthRoutes());
  app.get('/api/events', handleEventStream);
  app.get('/api/jobs/active', listActiveJobs);
  app.get('/api/webhooks/skipped/recent', listRecentSkippedWebhooks);
  app.get('/api/queue/snapshot', handleQueueSnapshot);

  app.post('/api/tasks', express.json({ limit: '1mb' }), createTaskHandler(agents));
  app.get('/api/tasks/:agent/:taskId', getTaskStatusHandler());
  app.get('/api/tasks/:agent/:taskId/wait', waitTaskHandler());

  for (const provider of getSettings().providers) {
    if (!isWebhookProvider(provider)) continue;
    new WebhookTransport(provider, app, agents).mount();
  }
}
