import express from 'express';
import type { Express } from 'express';

import { createHealthRoutes } from './health.routes';
import { createWebhookRoutes } from './webhook.routes';

export function registerRoutes(app: Express): void {
  app.use('/api/health', createHealthRoutes());
  app.use(
    '/hooks/jira',
    express.raw({ type: 'application/json', limit: '10mb' }),
    createWebhookRoutes(),
  );
}
