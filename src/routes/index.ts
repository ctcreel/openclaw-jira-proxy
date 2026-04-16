import express from 'express';
import type { Express } from 'express';

import { getSettings } from '../config';
import { createHealthRoutes } from './health.routes';
import { createWebhookHandler } from '../controllers/webhook.controller';
import { handleEventStream } from '../controllers/events.controller';
import type { ResolvedAgent } from '../services/agent-loader.service';

export function registerRoutes(app: Express, agents: readonly ResolvedAgent[]): void {
  app.use('/api/health', createHealthRoutes());
  app.get('/api/events', handleEventStream);

  const settings = getSettings();

  for (const provider of settings.providers) {
    app.post(
      provider.routePath,
      express.raw({ type: 'application/json', limit: '10mb' }),
      createWebhookHandler(provider, agents),
    );
  }
}
