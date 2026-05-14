import { describe, it, expect, beforeEach, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type IORedis from 'ioredis';
import express from 'express';
import supertest from 'supertest';

const VALID_TOKEN = 'integration-bearer-token';
const knownSecrets = new Map<string, string>([['builder_internal_bearer', VALID_TOKEN]]);
const redisInstance = new RedisMock() as unknown as IORedis;

interface FakeSecretManager {
  hasSecret: (key: string) => boolean;
  getSecret: (key: string) => string;
}

vi.mock('../../../src/secrets/manager', () => ({
  getSecretManager: (): FakeSecretManager => ({
    hasSecret: (key: string): boolean => knownSecrets.has(key),
    getSecret: (key: string): string => {
      const value = knownSecrets.get(key);
      if (value === undefined) throw new Error(`Unknown key: ${key}`);
      return value;
    },
  }),
}));

vi.mock('../../../src/services/dedup.service', () => ({
  getDedupRedis: (): IORedis => redisInstance,
}));

const { requireBuilderInternalBearer } =
  await import('../../../src/system-agents/builder/bearer-auth.middleware');
const { createDeployCompleteHandler, deployCompleteJsonParser } =
  await import('../../../src/system-agents/builder/deploy-complete.controller');

function makeApp(): express.Express {
  const app = express();
  app.post(
    '/webhooks/builder-deploy-complete',
    deployCompleteJsonParser,
    requireBuilderInternalBearer,
    createDeployCompleteHandler(),
  );
  return app;
}

describe('deploy-complete route (bearer + parser + handler chain)', () => {
  let app: express.Express;

  beforeEach(async () => {
    await redisInstance.flushall();
    app = makeApp();
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
