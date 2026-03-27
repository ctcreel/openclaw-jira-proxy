import express from 'express';
import type { Express } from 'express';

import { createHealthRoutes } from './health.routes';
import { createWebhookRoutes } from './webhook.routes';

export function registerRoutes(app: Express): void {
  // Health endpoint: accessible at both /api/health (direct) and /hooks/jira/api/health (via Tailscale Funnel)
  app.use('/api/health', createHealthRoutes());
  // Webhook endpoint: Tailscale Funnel strips the /hooks/jira prefix before forwarding,
  // so the proxy receives POST / — mount at root to match.
  app.use('/', express.raw({ type: 'application/json', limit: '10mb' }), createWebhookRoutes());
}
