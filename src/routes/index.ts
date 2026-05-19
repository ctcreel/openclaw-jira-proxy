import express from 'express';
import type { Express } from 'express';

import { createEntitiesRoutes } from './entities.routes';
import { createWorkspaceEntityModelHandler } from '../controllers/workspace-entity-model.controller';
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
  createWorkspaceTemplateHandler,
} from '../controllers/workspace.controller';
import { createWorkspaceEditHandler } from '../controllers/workspace-edit.controller';
import { RealGitOps } from '../services/workspace-git.service';
import {
  createTaskHandler,
  getTaskStatusHandler,
  waitTaskHandler,
} from '../controllers/task.controller';
import { requireAgentBearer } from '../middleware/bearer-auth.middleware';
import { createTailscaleIdentityMiddleware } from '../middleware/tailscale-identity.middleware';
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

  // Editor UI surface: workspace read, routing-schema export, on-demand
  // audit, and the PR-style write flow. All editor routes sit behind
  // the Tailscale-identity middleware — Tailscale's reverse proxy
  // injects user-identity headers on every tailnet request, the
  // middleware rejects anonymous requests with 401 and enforces an
  // optional operator allowlist. The server must bind tailnet-only for
  // this gate to be load-bearing; if exposed publicly an attacker
  // could synthesize the headers.
  const editorGate = createTailscaleIdentityMiddleware({
    allowlist: parseAllowlistFromEnvironment(),
  });
  app.get('/api/schema/routing', editorGate, handleRoutingSchema);
  app.get('/api/workspace/:agent', editorGate, createWorkspaceHandler(agents));
  app.get('/api/workspace/:agent/template/*', editorGate, createWorkspaceTemplateHandler(agents));
  app.post('/api/workspace/:agent/audit', editorGate, createWorkspaceAuditHandler(agents));
  app.post(
    '/api/workspace/:agent/edit',
    editorGate,
    express.json({ limit: '1mb' }),
    createWorkspaceEditHandler(agents, new RealGitOps(), {
      baseBranch: process.env['WORKSPACE_EDIT_BASE_BRANCH'] ?? 'main',
      authorEmail:
        process.env['WORKSPACE_EDIT_AUTHOR_EMAIL'] ??
        '277859894+sc0red-patch[bot]@users.noreply.github.com',
      authorName: process.env['WORKSPACE_EDIT_AUTHOR_NAME'] ?? 'sc0red-patch[bot]',
      branchNamePrefix: process.env['WORKSPACE_EDIT_BRANCH_PREFIX'] ?? 'workspace-edit',
    }),
  );

  app.post(
    '/api/tasks',
    express.json({ limit: '1mb' }),
    requireAgentBearer,
    createTaskHandler(agents),
  );
  app.get('/api/tasks/:agent/:taskId', requireAgentBearer, getTaskStatusHandler());
  app.get('/api/tasks/:agent/:taskId/wait', requireAgentBearer, waitTaskHandler());

  app.use('/api/memory', express.json({ limit: '1mb' }), createMemoryRoutes());

  // /api/agents/:agent/entities — per-tenant entity store, bearer-gated.
  // See openspec/changes/entities for the substrate spec.
  app.use('/api/agents/:agent/entities', requireAgentBearer, createEntitiesRoutes());

  // /api/agents/:agent/workspace/entity-model — workspace metadata
  // (kinds + schemas + relations.json + rules referencing entities).
  // Read-only. Sits behind the editor's Tailscale identity gate
  // because it's a workspace-introspection surface, not an agent
  // runtime tool.
  app.get(
    '/api/agents/:agent/workspace/entity-model',
    editorGate,
    createWorkspaceEntityModelHandler(agents),
  );

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

/**
 * Read the operator allowlist from `EDITOR_TAILSCALE_ALLOWLIST` (comma-
 * separated emails). Returning `undefined` lets any tailnet user past
 * the gate; returning a non-empty array enforces the allowlist; an
 * empty list (env set to `""`) is treated as "no one is allowed" and
 * works as a kill-switch.
 */
function parseAllowlistFromEnvironment(): readonly string[] | undefined {
  const raw = process.env['EDITOR_TAILSCALE_ALLOWLIST'];
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
