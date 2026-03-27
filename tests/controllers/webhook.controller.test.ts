import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';

import { createApp } from '../../src/app';

vi.mock('../../src/services/queue.service', () => ({
  getQueue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue(undefined),
  })),
}));

function computeSignature(body: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  return `sha256=${hex}`;
}

describe('Webhook Controller', () => {
  const app = createApp();
  const secret = 'test-hmac-secret';
  const payload = JSON.stringify({ webhookEvent: 'jira:issue_updated' });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 202 for valid HMAC signature', async () => {
    const signature = computeSignature(payload, secret);

    const response = await supertest(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signature)
      .send(payload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
  });

  it('should return 401 for invalid HMAC signature', async () => {
    const response = await supertest(app)
      .post('/')
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
      .post('/')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'md5=abc123')
      .send(payload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid signature' });
  });

  it('should return 401 for signature with wrong length', async () => {
    const response = await supertest(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'sha256=abcd')
      .send(payload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid signature' });
  });

  it('should return 401 when signature header is missing', async () => {
    const response = await supertest(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Missing signature' });
  });
});
