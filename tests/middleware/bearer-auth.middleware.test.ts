import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

import { requireAgentBearer } from '../../src/middleware/bearer-auth.middleware';
import { resetSettings } from '../../src/config';

const VALID_TOKEN = 'middleware-test-token';

function makeApp(): express.Express {
  const app = express();
  app.get('/protected', requireAgentBearer, (_request, response) => {
    response.status(200).json({ ok: true });
  });
  return app;
}

describe('requireAgentBearer', () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env['CLAWNDOM_AGENT_TOKEN'];
    process.env['CLAWNDOM_AGENT_TOKEN'] = VALID_TOKEN;
    resetSettings();
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env['CLAWNDOM_AGENT_TOKEN'];
    } else {
      process.env['CLAWNDOM_AGENT_TOKEN'] = originalToken;
    }
    resetSettings();
  });

  it('allows requests with the matching Bearer token', async () => {
    const response = await supertest(makeApp())
      .get('/protected')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('rejects requests with a missing Authorization header (401)', async () => {
    const response = await supertest(makeApp()).get('/protected');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects requests using a non-Bearer scheme (401)', async () => {
    const response = await supertest(makeApp())
      .get('/protected')
      .set('Authorization', `Basic ${VALID_TOKEN}`);
    expect(response.status).toBe(401);
  });

  it('rejects requests with the wrong token (401)', async () => {
    const response = await supertest(makeApp())
      .get('/protected')
      .set('Authorization', 'Bearer wrong-token');
    expect(response.status).toBe(401);
  });

  it('rejects when the configured token is empty', async () => {
    delete process.env['CLAWNDOM_AGENT_TOKEN'];
    resetSettings();
    const response = await supertest(makeApp())
      .get('/protected')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(response.status).toBe(401);
  });

  it('picks up the token freshly on every request (resetSettings takes effect)', async () => {
    // First request with old token succeeds.
    const ok = await supertest(makeApp())
      .get('/protected')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(ok.status).toBe(200);

    // Rotate the token mid-flight.
    process.env['CLAWNDOM_AGENT_TOKEN'] = 'rotated-token';
    resetSettings();

    const stale = await supertest(makeApp())
      .get('/protected')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(stale.status).toBe(401);

    const fresh = await supertest(makeApp())
      .get('/protected')
      .set('Authorization', 'Bearer rotated-token');
    expect(fresh.status).toBe(200);
  });
});
