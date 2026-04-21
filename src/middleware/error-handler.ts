import type { ErrorRequestHandler } from 'express';

import { ClawndomError } from '../lib/exceptions';
import { getLogger } from '../lib/logging';

export function createErrorHandler(): ErrorRequestHandler {
  const logger = getLogger('error-handler');

  return (error: unknown, _request, response, _next) => {
    if (error instanceof ClawndomError) {
      logger.warn({ error: error.toLogDict() }, error.message);

      response.status(error.httpStatus).json({
        type: `https://errors.clawndom.dev/${error.errorCode}`,
        title: error.errorCode
          .replaceAll('_', ' ')
          .replaceAll(/\b\w/g, (char) => char.toUpperCase()),
        status: error.httpStatus,
        detail: error.message,
        ...(Object.keys(error.context).length > 0 ? { context: error.context } : {}),
      });
      return;
    }

    logger.error({ error }, 'Unhandled error');

    response.status(500).json({
      type: 'https://errors.clawndom.dev/INTERNAL_ERROR',
      title: 'Internal Error',
      status: 500,
      detail: 'An unexpected error occurred',
    });
  };
}
