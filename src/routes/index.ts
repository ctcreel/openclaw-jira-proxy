import type { Express } from 'express';

import { createHealthRoutes } from './health.routes';

export function registerRoutes(app: Express): void {
  app.use('/api/health', createHealthRoutes());
}
