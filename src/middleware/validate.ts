import type { RequestHandler } from 'express';
import type { ZodSchema } from 'zod';

import { ValidationError } from '../lib/exceptions';

interface ValidationSchemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (request, _response, next) => {
    if (schemas.body) {
      const result = schemas.body.safeParse(request.body);
      if (!result.success) {
        throw new ValidationError('Invalid request body', {
          context: { errors: result.error.flatten().fieldErrors },
        });
      }
      request.body = result.data;
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(request.params);
      if (!result.success) {
        throw new ValidationError('Invalid path parameters', {
          context: { errors: result.error.flatten().fieldErrors },
        });
      }
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(request.query);
      if (!result.success) {
        throw new ValidationError('Invalid query parameters', {
          context: { errors: result.error.flatten().fieldErrors },
        });
      }
    }

    next();
  };
}
