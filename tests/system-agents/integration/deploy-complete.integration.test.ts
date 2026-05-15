import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type IORedis from 'ioredis';
import express from 'express';
import supertest from 'supertest';

import { resetSettings } from '../../../src/config';
import { requireAgentBearer } from '../../../src/middleware/bearer-auth.middleware';

const VALID_TOKEN = 'integration-bearer-token';
const redisInstance: IORedis = new RedisMock();

vi.mock('../../../src/services/dedup.service', () => ({
  getDedupRedis: (): IORedis => redisInstance,
}));

const { createDeployCompleteHandler, deployCompleteJsonParser } =
  await import('../../../src/system-agents/builder/deploy-complete.controller');

function buildTestApp(): express.Express {
  const app = express();
  app.post(
    '/webhooks/builder-deploy-complete',
    deployCompleteJsonParser,
    requireAgentBearer,
    createDeployCompleteHandler(),
  );
  return app;
}

describe('deploy-complete route (CLAWNDOM_AGENT_TOKEN + parser + handler chain)', () => {
  let app: express.Express;
  let originalToken: string | undefined;

  beforeEach(async () => {
    originalToken = process.env['CLAWNDOM_AGENT_TOKEN'];
    process.env['CLAWNDOM_AGENT_TOKEN'] = VALID_TOKEN;
    resetSettings();
    await redisInstance.flushall();
    app = buildTestApp();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env['CLAWNDOM_AGENT_TOKEN'];
    else process.env['CLAWNDOM_AGENT_TOKEN'] = originalToken;
    resetSettings();
  });

  it('a fully-valid supervisor call: 202 + dedupe entry written', async () => {
    const response = await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ jobId: 'job-integration-1', status: 'ok' })
      .expect(202);
    expect(response.body).toEqual({ accepted: true, state: 'testable' });
    expect(await redisInstance.get('builder:callback:event:job-integration-1:testable')).toBe('1');
  });

  it('rejected without Authorization header (401)', async () => {
    await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({ jobId: 'job-1', status: 'ok' })
      .expect(401);
  });

  it('rejected with wrong bearer token (401)', async () => {
    await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .set('Authorization', 'Bearer not-the-token')
      .send({ jobId: 'job-1', status: 'ok' })
      .expect(401);
  });

  it('valid bearer with invalid payload still returns 400 (parser/zod runs)', async () => {
    await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ status: 'ok' })
      .expect(400);
  });

  it('duplicate supervisor delivery returns 202 with deduped:true, no side effect', async () => {
    await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ jobId: 'job-dup', status: 'ok' })
      .expect(202);

    const second = await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ jobId: 'job-dup', status: 'ok' })
      .expect(202);
    expect(second.body).toEqual({ accepted: true, deduped: true });
  });

  it('failed status records under the failed event_id and returns failed state', async () => {
    const response = await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({
        jobId: 'job-fail',
        status: 'failed',
        reason: 'service did not come up',
      })
      .expect(202);
    expect(response.body).toEqual({ accepted: true, state: 'failed' });
    expect(await redisInstance.get('builder:callback:event:job-fail:failed')).toBe('1');
  });
});
