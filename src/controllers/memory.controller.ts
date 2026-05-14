import type { Request, Response } from 'express';
import { z } from 'zod';

import { getSettings } from '../config';
import { getStringHeader, getStringParameter } from '../lib/extract';
import { getLogger } from '../lib/logging';
import {
  ProviderNotRegisteredError,
  RateLimitExceededError,
  UnknownNamespaceError,
  getMemoryService,
} from '../services/memory/memory.service';

const logger = getLogger('memory-controller');

const BEARER_PREFIX = 'Bearer ';

const storeSchema = z.object({
  namespace: z.string().min(1),
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  traceId: z.string().min(1),
});

const searchSchema = z.object({
  namespace: z.string().min(1),
  query: z.string().min(1),
  topK: z.number().int().positive().max(50).optional(),
  minSimilarity: z.number().min(-1).max(1).optional(),
  traceId: z.string().min(1).optional(),
});

const deleteSchema = z.object({
  namespace: z.string().min(1),
});

function authenticate(request: Request): boolean {
  const expected = getSettings().agentToken;
  if (!expected) {
    logger.error('CLAWNDOM_AGENT_TOKEN is not configured; rejecting memory request');
    return false;
  }
  const header = getStringHeader(request, 'authorization');
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    return false;
  }
  return header.slice(BEARER_PREFIX.length) === expected;
}

/**
 * Map MemoryService typed errors to HTTP status codes. Unknown errors
 * surface as 500. The controller never leaks internals (vector contents,
 * API keys) — error messages are scrubbed by the service before throwing,
 * but this is the second line of defense.
 */
function getStatusFor(error: unknown): number {
  if (error instanceof UnknownNamespaceError) return 400;
  if (error instanceof ProviderNotRegisteredError) return 500;
  if (error instanceof RateLimitExceededError) return 429;
  return 500;
}

export async function postMemoryStore(request: Request, response: Response): Promise<void> {
  if (!authenticate(request)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const parsed = storeSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  try {
    const service = getMemoryService();
    const result = await service.store(parsed.data);
    response.status(200).json(result);
  } catch (error) {
    const status = getStatusFor(error);
    const message = error instanceof Error ? error.message : 'Memory store failed';
    if (status >= 500) {
      logger.error({ error: message }, 'Memory store failed');
    }
    response.status(status).json({ error: message });
  }
}

export async function postMemorySearch(request: Request, response: Response): Promise<void> {
  if (!authenticate(request)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const parsed = searchSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  try {
    const service = getMemoryService();
    const result = await service.search(parsed.data);
    response.status(200).json(result);
  } catch (error) {
    const status = getStatusFor(error);
    const message = error instanceof Error ? error.message : 'Memory search failed';
    if (status >= 500) {
      logger.error({ error: message }, 'Memory search failed');
    }
    response.status(status).json({ error: message });
  }
}

export async function deleteMemoryEntry(request: Request, response: Response): Promise<void> {
  if (!authenticate(request)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const parsed = deleteSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }
  const idParameter = getStringParameter(request, 'id');
  if (idParameter === undefined) {
    response.status(400).json({ error: 'Missing :id path parameter' });
    return;
  }
  try {
    const service = getMemoryService();
    const result = await service.delete({ namespace: parsed.data.namespace, id: idParameter });
    response.status(200).json(result);
  } catch (error) {
    const status = getStatusFor(error);
    const message = error instanceof Error ? error.message : 'Memory delete failed';
    if (status >= 500) {
      logger.error({ error: message }, 'Memory delete failed');
    }
    response.status(status).json({ error: message });
  }
}
