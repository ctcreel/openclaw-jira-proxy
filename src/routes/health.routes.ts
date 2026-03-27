import { Router } from 'express';

import { getHealth } from '../controllers/health.controller';

export function createHealthRoutes(): Router {
  const router = Router();
  router.get('/', getHealth);
  return router;
}
