import express from 'express';
import type { Express } from 'express';

import { createErrorHandler } from './middleware/error-handler';
import { createRequestLogger } from './middleware/request-logger';
import { registerRoutes } from './routes';
import type { ResolvedAgent } from './services/agent-loader.service';

export function createApp(agents: readonly ResolvedAgent[]): Express {
  const app = express();

  app.use(createRequestLogger());

  registerRoutes(app, agents);

  app.use(createErrorHandler());

  return app;
}
