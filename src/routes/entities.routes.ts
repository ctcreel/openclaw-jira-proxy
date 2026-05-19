import express, { Router } from 'express';

import {
  createAuditEntityHandler,
  createGetEntityHandler,
  createListEntitiesHandler,
  createPurgeEntityHandler,
  createRelateEntityHandler,
  createUnrelateEntityHandler,
  createUpsertEntityHandler,
} from '../controllers/entities.controller';

export function createEntitiesRoutes(): Router {
  const router = Router({ mergeParams: true });
  const json = express.json({ limit: '1mb' });
  router.get('/', createListEntitiesHandler());
  router.get('/:id', createGetEntityHandler());
  router.post('/', json, createUpsertEntityHandler());
  router.post('/:id/relations', json, createRelateEntityHandler());
  router.delete('/:id/relations/:type/:to', createUnrelateEntityHandler());
  router.post('/:id/purge', json, createPurgeEntityHandler());
  router.get('/:id/audit', createAuditEntityHandler());
  return router;
}
