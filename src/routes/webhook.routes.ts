import { Router } from 'express';

import { receiveWebhook } from '../controllers/webhook.controller';

export function createWebhookRoutes(): Router {
  const router = Router();
  router.post('/', receiveWebhook);
  return router;
}
