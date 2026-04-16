import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';

import { createApp } from '../../src/app';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';

vi.mock('../../src/services/queue.service', () => ({
  getProviderQueue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue({ id: 'test-job' }),
  })),
}));

function computeSignature(body: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  return `sha256=${hex}`;
}

const CATCH_ALL_AGENTS: ResolvedAgent[] = [
  {
    name: 'patch',
    dir: '/tmp/clawndom-test-agent',
    config: {
      routing: { 'test-provider': { rules: [{ condition: { all_of: [] } }] } },
      modelRules: {},
    },
  },
];

describe('Webhook Controller', () => {
  const app = createApp(CATCH_ALL_AGENTS);
  const secret = 'test-hmac-secret';
  const payload = JSON.stringify({ event: 'test_event' });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 202 for valid HMAC signature', async () => {
    const signature = computeSignature(payload, secret);

    const response = await supertest(app)
      .post('/hooks/test')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signature)
      .send(payload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
  });

  it('should return 401 for invalid HMAC signature', async () => {
    const response = await supertest(app)
      .post('/hooks/test')
      .set('Content-Type', 'application/json')
      .set(
        'X-Hub-Signature',
        'sha256=deadbeef00000000000000000000000000000000000000000000000000000000',
      )
      .send(payload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid signature' });
  });

  it('should return 401 for signature with wrong prefix', async () => {
    const response = await supertest(app)
      .post('/hooks/test')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'md5=abc123')
      .send(payload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid signature' });
  });

  it('should return 401 for signature with wrong length', async () => {
    const response = await supertest(app)
      .post('/hooks/test')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'sha256=abcd')
      .send(payload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid signature' });
  });

  it('should return 401 when signature header is missing', async () => {
    const response = await supertest(app)
      .post('/hooks/test')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Missing signature' });
  });
});
