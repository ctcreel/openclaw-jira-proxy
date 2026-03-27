import type { RequestHandler } from 'express';

import { getLogger } from '../lib/logging';
import {
  generateCorrelationId,
  setCorrelationId,
  setExtraContext,
  clearContext,
} from '../lib/logging/context';

const CORRELATION_HEADERS = ['x-request-id', 'x-correlation-id', 'x-trace-id'] as const;

export function createRequestLogger(): RequestHandler {
  const logger = getLogger('http');

  return (request, response, next) => {
    const startTime = performance.now();

    // Extract or generate correlation ID
    let correlationId = '';
    for (const header of CORRELATION_HEADERS) {
      const value = request.headers[header];
      if (typeof value === 'string') {
        correlationId = value;
        break;
      }
    }
    if (!correlationId) {
      correlationId = generateCorrelationId();
    } else {
      setCorrelationId(correlationId);
    }

    setExtraContext({
      httpMethod: request.method,
      path: request.path,
      clientIp: request.ip ?? 'unknown',
    });

    response.setHeader('x-correlation-id', correlationId);

    logger.info({ event: 'request_started' }, `${request.method} ${request.path}`);

    response.on('finish', () => {
      const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
      logger.info(
        { event: 'request_completed', statusCode: response.statusCode, durationMs },
        `${request.method} ${request.path} ${response.statusCode}`,
      );
      clearContext();
    });

    next();
  };
}
