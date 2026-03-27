import { describe, it, expect, vi } from 'vitest';
import supertest from 'supertest';
import express from 'express';

import { createErrorHandler } from '../../src/middleware/error-handler';
import { ValidationError, NotFoundError } from '../../src/lib/exceptions';

function createTestApp(handler: express.RequestHandler): express.Express {
  const app = express();
  app.get('/test', handler);
  app.use(createErrorHandler());
  return app;
}

describe('Error Handler Middleware', () => {
  it('should return RFC 7807 format for Sc0redError', async () => {
    const app = createTestApp((_req, _res) => {
      throw new ValidationError('Bad input', { field: 'email' });
    });

    const response = await supertest(app).get('/test');
    expect(response.status).toBe(400);
    expect(response.body.type).toContain('VALIDATION_ERROR');
    expect(response.body.detail).toBe('Bad input');
  });

  it('should return 404 for NotFoundError', async () => {
    const app = createTestApp((_req, _res) => {
      throw new NotFoundError('User not found', { resourceType: 'User' });
    });

    const response = await supertest(app).get('/test');
    expect(response.status).toBe(404);
    expect(response.body.detail).toBe('User not found');
  });

  it('should return 500 for unknown errors', async () => {
    const app = createTestApp((_req, _res) => {
      throw new Error('unexpected');
    });

    const response = await supertest(app).get('/test');
    expect(response.status).toBe(500);
    expect(response.body.detail).toBe('An unexpected error occurred');
  });
});
