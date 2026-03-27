import { describe, it, expect } from 'vitest';
import supertest from 'supertest';

import { createApp } from '../../src/app';

describe('GET /api/health', () => {
  const app = createApp();

  it('should return 200 with healthy status', async () => {
    const response = await supertest(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
  });

  it('should include version and environment', async () => {
    const response = await supertest(app).get('/api/health');
    expect(response.body).toHaveProperty('version');
    expect(response.body).toHaveProperty('environment');
    expect(response.body).toHaveProperty('timestamp');
  });

  it('should include application check', async () => {
    const response = await supertest(app).get('/api/health');
    expect(response.body.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'application', status: 'healthy' })]),
    );
  });
});
