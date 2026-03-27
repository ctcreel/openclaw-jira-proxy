import type { RequestHandler } from 'express';

import { clearContext, generateCorrelationId, setCorrelationId, setExtraContext } from '../context';
import { getLogger } from '../logger';

const CORRELATION_HEADERS = ['x-request-id', 'x-correlation-id', 'x-trace-id'] as const;

const logger = getLogger('middleware.logging');

export function createLoggingMiddleware(options?: {
  logRequests?: boolean;
  logResponses?: boolean;
}): RequestHandler {
  const logRequests = options?.logRequests ?? true;
  const logResponses = options?.logResponses ?? true;

  return (request, response, next) => {
    const startTime = performance.now();

    let correlationId = '';
    for (const header of CORRELATION_HEADERS) {
      const value = request.headers[header];
      if (typeof value === 'string') {
        correlationId = value;
        break;
      }
    }

    if (correlationId) {
      setCorrelationId(correlationId);
    } else {
      correlationId = generateCorrelationId();
    }

    setExtraContext({
      httpMethod: request.method,
      path: request.path,
      clientIp: request.ip ?? 'unknown',
    });

    response.setHeader('x-correlation-id', correlationId);

    if (logRequests) {
      logger.info({ event: 'request_started' }, `${request.method} ${request.path}`);
    }

    response.on('finish', () => {
      if (logResponses) {
        const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
        logger.info(
          { event: 'request_completed', statusCode: response.statusCode, durationMs },
          `${request.method} ${request.path} ${response.statusCode}`,
        );
      }
      clearContext();
    });

    next();
  };
}
