import { describe, it, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const VALID_TOKEN = 'builder-internal-bearer-test-value';
const knownSecrets = new Map<string, string>([['builder_internal_bearer', VALID_TOKEN]]);

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

const { requireBuilderInternalBearer } =
  await import('../../../src/system-agents/builder/bearer-auth.middleware');

function makeApp(): express.Express {
  const app = express();
  app.get('/protected', requireBuilderInternalBearer, (_request, response) => {
    response.status(200).json({ ok: true });
  });
  return app;
}

describe('requireBuilderInternalBearer', () => {
  let app: express.Express;

  beforeEach(() => {
    app = makeApp();
  });

  it('rejects requests with no Authorization header (401)', async () => {
    await supertest(app).get('/protected').expect(401);
  });

  it('rejects requests with an Authorization header that is not Bearer (401)', async () => {
    await supertest(app).get('/protected').set('Authorization', 'Basic something').expect(401);
  });

  it('rejects requests with the wrong bearer token (401)', async () => {
    await supertest(app).get('/protected').set('Authorization', 'Bearer wrong-token').expect(401);
  });

  it('rejects requests with a Bearer of a different length (401, timing-safe)', async () => {
    await supertest(app).get('/protected').set('Authorization', 'Bearer short').expect(401);
  });

  it('admits requests with the correct bearer token (200)', async () => {
    await supertest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .expect(200);
  });

  it('rejects when the secret manager has no entry for the key (401)', async () => {
    knownSecrets.delete('builder_internal_bearer');
    try {
      await supertest(app)
        .get('/protected')
        .set('Authorization', `Bearer ${VALID_TOKEN}`)
        .expect(401);
    } finally {
      knownSecrets.set('builder_internal_bearer', VALID_TOKEN);
    }
  });
});
