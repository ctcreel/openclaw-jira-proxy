import express from 'express';
import type { Express } from 'express';

import { createHealthRoutes } from './health.routes';
import { createMemoryRoutes } from './memory.routes';
import { createScheduledTasksRoutes } from './scheduled-tasks.routes';
import { createVersionRoutes } from './version.routes';
import { getSettings, isWebhookProvider } from '../config';
import { handleEventStream } from '../controllers/events.controller';
import { listActiveJobs } from '../controllers/active-jobs.controller';
import { createContextSchemasHandler } from '../controllers/context-schemas.controller';
import { listRecentSkippedWebhooks } from '../controllers/skipped-webhooks.controller';
import { handleQueueSnapshot } from '../controllers/queue-snapshot.controller';
import { handleRoutingSchema } from '../controllers/schema.controller';
import { listAgentTools, listToolCatalog } from '../controllers/tool-catalog.controller';
import {
  createWorkspaceAuditHandler,
  createWorkspaceHandler,
} from '../controllers/workspace.controller';
import {
  createTaskHandler,
  getTaskStatusHandler,
  waitTaskHandler,
} from '../controllers/task.controller';
import { requireAgentBearer } from '../middleware/bearer-auth.middleware';
import type { ResolvedAgent } from '../services/agent-loader.service';
import { WebhookTransport } from '../strategies/transport';
import {
  createDeployCompleteHandler,
  deployCompleteJsonParser,
} from '../system-agents/builder/deploy-complete.controller';

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

  app.get('/api/tools/catalog', listToolCatalog);
  app.get('/api/agents/:agent/tools', listAgentTools);
  app.get('/api/agents/:agent/context-schemas', createContextSchemasHandler(agents));

  // Editor UI surface: a workspace read endpoint, a routing-schema
  // export, and an on-demand audit. Reads are open within the tailnet;
  // a future write endpoint (PR-style edits to clawndom.yaml) will
  // sit behind the Tailscale-identity middleware.
  app.get('/api/schema/routing', handleRoutingSchema);
  app.get('/api/workspace/:agent', createWorkspaceHandler(agents));
  app.post('/api/workspace/:agent/audit', createWorkspaceAuditHandler(agents));

  app.post(
    '/api/tasks',
    express.json({ limit: '1mb' }),
    requireAgentBearer,
    createTaskHandler(agents),
  );
  app.get('/api/tasks/:agent/:taskId', requireAgentBearer, getTaskStatusHandler());
  app.get('/api/tasks/:agent/:taskId/wait', requireAgentBearer, waitTaskHandler());

  app.use('/api/memory', express.json({ limit: '1mb' }), createMemoryRoutes());

  // /api/version — agent_version hash + per-repo breakdown. Bearer-gated.
  // See openspec/changes/spe-2078-tool-use/specs/agent-versioning/spec.md.
  app.use('/api/version', requireAgentBearer, createVersionRoutes());

  // /api/scheduled-tasks — registry CRUD. Bearer-gated at the parent
  // mount; the inner routes are auth-agnostic so they can be unit-tested
  // without the middleware.
  app.use(
    '/api/scheduled-tasks',
    express.json({ limit: '1mb' }),
    requireAgentBearer,
    createScheduledTasksRoutes(agents),
  );

  app.post(
    '/webhooks/builder-deploy-complete',
    deployCompleteJsonParser,
    requireAgentBearer,
    createDeployCompleteHandler(),
  );

  for (const provider of getSettings().providers) {
    if (!isWebhookProvider(provider)) continue;
    new WebhookTransport(provider, app, agents).mount();
  }
}
