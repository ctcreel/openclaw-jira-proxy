import express from 'express';
import type { Express } from 'express';

import { createErrorHandler } from './middleware/error-handler';
import { createRequestLogger } from './middleware/request-logger';
import { registerRoutes } from './routes';

export function createApp(): Express {
  const app = express();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(createRequestLogger());

  registerRoutes(app);

  app.use(createErrorHandler());

  return app;
}
