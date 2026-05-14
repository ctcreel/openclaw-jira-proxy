import { describe, it, expect, beforeEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type IORedis from 'ioredis';
import express from 'express';
import supertest from 'supertest';

const redisInstance = new RedisMock() as unknown as IORedis;

vi.mock('../../../src/services/dedup.service', () => ({
  getDedupRedis: (): IORedis => redisInstance,
}));

const { createDeployCompleteHandler, deployCompleteJsonParser } =
  await import('../../../src/system-agents/builder/deploy-complete.controller');

function makeApp(): express.Express {
  const app = express();
  app.post(
    '/webhooks/builder-deploy-complete',
    deployCompleteJsonParser,
    createDeployCompleteHandler(),
  );
  return app;
}

describe('deploy-complete controller', () => {
  let app: express.Express;

  beforeEach(async () => {
    await redisInstance.flushall();
    app = makeApp();
  });

  it('accepts a valid ok signal and records the event', async () => {
    const response = await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({ jobId: 'job-42', status: 'ok' })
      .expect(202);
    expect(response.body).toEqual({ accepted: true, state: 'testable' });
    expect(await redisInstance.get('builder:callback:event:job-42:testable')).toBe('1');
  });

  it('accepts a valid failed signal and records as failed state', async () => {
    const response = await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({
        jobId: 'job-42',
        status: 'failed',
        reason: 'health check did not pass',
      })
      .expect(202);
    expect(response.body).toEqual({ accepted: true, state: 'failed' });
    expect(await redisInstance.get('builder:callback:event:job-42:failed')).toBe('1');
  });

  it('returns 202 with deduped:true on duplicate delivery', async () => {
    await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({ jobId: 'job-42', status: 'ok' })
      .expect(202);

    const second = await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({ jobId: 'job-42', status: 'ok' })
      .expect(202);
    expect(second.body).toEqual({ accepted: true, deduped: true });
  });

  it('rejects a payload missing jobId (400)', async () => {
    await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({ status: 'ok' })
      .expect(400);
  });

  it('rejects a payload with unknown status (400)', async () => {
    await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({ jobId: 'job-42', status: 'maybe' })
      .expect(400);
  });

  it('rejects a payload with unknown fields (strict, 400)', async () => {
    await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({ jobId: 'job-42', status: 'ok', bonus: 'no' })
      .expect(400);
  });

  it('keeps ok and failed events for the same jobId distinct', async () => {
    await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({ jobId: 'job-42', status: 'ok' })
      .expect(202);
    const response = await supertest(app)
      .post('/webhooks/builder-deploy-complete')
      .send({ jobId: 'job-42', status: 'failed', reason: 'race' })
      .expect(202);
    expect(response.body.deduped).toBeUndefined();
  });
});
