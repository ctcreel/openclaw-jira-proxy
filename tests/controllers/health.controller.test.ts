import { describe, it, expect } from 'vitest';
import supertest from 'supertest';

import { createApp } from '../../src/app';

describe('Health Controller', () => {
  const app = createApp();

  it('should return 200 for healthy application', async () => {
    const response = await supertest(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('healthy');
  });
});
