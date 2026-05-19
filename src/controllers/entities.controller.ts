import type { Request, Response } from 'express';
import { z } from 'zod';

import { getStringParameter } from '../lib/extract';
import { getLogger } from '../lib/logging';
import { type EntityRegistry, getEntityRegistry } from '../services/entities/entity-registry';
import { EntityStoreError } from '../services/entities/entity-store.service';

const logger = getLogger('entities-controller');

const upsertSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
  id: z.string().min(1).optional(),
  trace_id: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
});

const relateSchema = z.object({
  type: z.string().min(1),
  to_id: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).optional(),
  trace_id: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
});

const purgeSchema = z.object({
  reason: z.string().min(1),
  trace_id: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
});

const orderFieldSchema = z.enum(['created_at', 'updated_at', 'name']);
const orderDirectionSchema = z.enum(['asc', 'desc']);

function parseFindQuery(request: Request): {
  kinds?: string[];
  q?: string;
  related_to?: string;
  relation_type?: string;
  text_match?: string;
  status?: string;
  order?: { field: 'created_at' | 'updated_at' | 'name'; dir: 'asc' | 'desc' };
  limit?: number;
} {
  const result: ReturnType<typeof parseFindQuery> = {};
  const kindsParameter = request.query['kinds'];
  if (typeof kindsParameter === 'string') {
    result.kinds = kindsParameter.split(',').filter((k) => k !== '');
  }
  const q = request.query['q'];
  if (typeof q === 'string' && q !== '') result.q = q;
  const relatedTo = request.query['related_to'];
  if (typeof relatedTo === 'string' && relatedTo !== '') result.related_to = relatedTo;
  const relationType = request.query['relation_type'];
  if (typeof relationType === 'string' && relationType !== '') {
    result.relation_type = relationType;
  }
  const textMatch = request.query['text_match'];
  if (typeof textMatch === 'string' && textMatch !== '') result.text_match = textMatch;
  const status = request.query['status'];
  if (typeof status === 'string' && status !== '') result.status = status;
  const orderField = request.query['order_field'];
  const orderDir = request.query['order_dir'];
  if (typeof orderField === 'string' && typeof orderDir === 'string') {
    const fieldParsed = orderFieldSchema.safeParse(orderField);
    const dirParsed = orderDirectionSchema.safeParse(orderDir);
    if (fieldParsed.success && dirParsed.success) {
      result.order = { field: fieldParsed.data, dir: dirParsed.data };
    }
  }
  const limit = request.query['limit'];
  if (typeof limit === 'string') {
    const parsed = parseInt(limit, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 500) {
      result.limit = parsed;
    }
  }
  return result;
}

function getAgentContext(
  request: Request,
  response: Response,
  registry: EntityRegistry,
): ReturnType<EntityRegistry['get']> {
  const agent = getStringParameter(request, 'agent');
  if (agent === undefined) {
    response.status(400).json({ error: 'Missing :agent path parameter' });
    return null;
  }
  const context = registry.get(agent);
  if (context === null) {
    response.status(404).json({ error: `Agent '${agent}' has no entity store` });
    return null;
  }
  return context;
}

function handleStoreError(error: unknown, response: Response, operation: string): void {
  if (error instanceof EntityStoreError) {
    const status =
      error.code === 'SCHEMA_VALIDATION_FAILED' ||
      error.code === 'KIND_REQUIRED' ||
      error.code === 'PURGE_REASON_REQUIRED'
        ? 400
        : error.code === 'ENTITY_NOT_FOUND'
          ? 404
          : error.code === 'RELATION_TARGET_MISSING'
            ? 400
            : 500;
    response
      .status(status)
      .json({ error: error.message, code: error.code, details: error.details });
    if (status >= 500) {
      logger.error({ error: error.message, code: error.code }, `entity.${operation} failed`);
    }
    return;
  }
  const message = error instanceof Error ? error.message : 'unknown error';
  logger.error({ error: message }, `entity.${operation} failed`);
  response.status(500).json({ error: message });
}

export function createListEntitiesHandler(registry: EntityRegistry = getEntityRegistry()) {
  return (request: Request, response: Response): void => {
    const context = getAgentContext(request, response, registry);
    if (context === null) return;
    try {
      const query = parseFindQuery(request);
      const results = context.store.find(query);
      response.status(200).json({ entities: results });
    } catch (error) {
      handleStoreError(error, response, 'find');
    }
  };
}

export function createGetEntityHandler(registry: EntityRegistry = getEntityRegistry()) {
  return (request: Request, response: Response): void => {
    const context = getAgentContext(request, response, registry);
    if (context === null) return;
    const id = getStringParameter(request, 'id');
    if (id === undefined) {
      response.status(400).json({ error: 'Missing :id path parameter' });
      return;
    }
    try {
      const expand = request.query['expand'] === 'relations';
      const result = context.store.get(id, { expand_relations: expand });
      if (result === null) {
        response.status(404).json({ error: `Entity '${id}' not found` });
        return;
      }
      response.status(200).json({ entity: result });
    } catch (error) {
      handleStoreError(error, response, 'get');
    }
  };
}

export function createUpsertEntityHandler(registry: EntityRegistry = getEntityRegistry()) {
  return (request: Request, response: Response): void => {
    const context = getAgentContext(request, response, registry);
    if (context === null) return;
    const parsed = upsertSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }
    try {
      const entity = context.store.upsert(
        parsed.data.kind,
        parsed.data.name,
        parsed.data.properties,
        {
          id: parsed.data.id,
          trace_id: parsed.data.trace_id ?? null,
          actor: parsed.data.actor ?? null,
        },
      );
      response.status(200).json({ entity });
    } catch (error) {
      handleStoreError(error, response, 'upsert');
    }
  };
}

export function createRelateEntityHandler(registry: EntityRegistry = getEntityRegistry()) {
  return (request: Request, response: Response): void => {
    const context = getAgentContext(request, response, registry);
    if (context === null) return;
    const fromId = getStringParameter(request, 'id');
    if (fromId === undefined) {
      response.status(400).json({ error: 'Missing :id path parameter' });
      return;
    }
    const parsed = relateSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }
    try {
      context.store.relate(
        fromId,
        parsed.data.type,
        parsed.data.to_id,
        parsed.data.properties ?? null,
        {
          trace_id: parsed.data.trace_id ?? null,
          actor: parsed.data.actor ?? null,
        },
      );
      response.status(200).json({ ok: true });
    } catch (error) {
      handleStoreError(error, response, 'relate');
    }
  };
}

export function createUnrelateEntityHandler(registry: EntityRegistry = getEntityRegistry()) {
  return (request: Request, response: Response): void => {
    const context = getAgentContext(request, response, registry);
    if (context === null) return;
    const fromId = getStringParameter(request, 'id');
    const relationType = getStringParameter(request, 'type');
    const toId = getStringParameter(request, 'to');
    if (fromId === undefined || relationType === undefined || toId === undefined) {
      response.status(400).json({ error: 'Missing path parameter (id, type, to)' });
      return;
    }
    try {
      context.store.unrelate(fromId, relationType, toId);
      response.status(200).json({ ok: true });
    } catch (error) {
      handleStoreError(error, response, 'unrelate');
    }
  };
}

export function createPurgeEntityHandler(registry: EntityRegistry = getEntityRegistry()) {
  return (request: Request, response: Response): void => {
    const context = getAgentContext(request, response, registry);
    if (context === null) return;
    const id = getStringParameter(request, 'id');
    if (id === undefined) {
      response.status(400).json({ error: 'Missing :id path parameter' });
      return;
    }
    const parsed = purgeSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }
    try {
      context.store.purge(id, parsed.data.reason, {
        trace_id: parsed.data.trace_id ?? null,
        actor: parsed.data.actor ?? null,
      });
      response.status(200).json({ ok: true });
    } catch (error) {
      handleStoreError(error, response, 'purge');
    }
  };
}

export function createAuditEntityHandler(registry: EntityRegistry = getEntityRegistry()) {
  return (request: Request, response: Response): void => {
    const context = getAgentContext(request, response, registry);
    if (context === null) return;
    const id = getStringParameter(request, 'id');
    if (id === undefined) {
      response.status(400).json({ error: 'Missing :id path parameter' });
      return;
    }
    const since = request.query['since'];
    const sinceMs = typeof since === 'string' ? parseInt(since, 10) : NaN;
    try {
      const records = context.store.auditFor(id, Number.isNaN(sinceMs) ? undefined : sinceMs);
      response.status(200).json({ audit: records });
    } catch (error) {
      handleStoreError(error, response, 'audit');
    }
  };
}
