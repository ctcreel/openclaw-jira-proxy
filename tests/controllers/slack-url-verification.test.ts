import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';

import { resetSettings } from '../../src/config';
import { createApp } from '../../src/app';

vi.mock('../../src/services/queue.service', () => ({
  getProviderQueue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue(undefined),
  })),
}));

function computeSlackSignature(secret: string, timestamp: string, body: string): string {
  const basestring = `v0:${timestamp}:${body}`;
  const hex = createHmac('sha256', secret).update(basestring).digest('hex');
  return `v0=${hex}`;
}

describe('Slack URL verification', () => {
  const secret = 'slack-test-secret';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROVIDERS_CONFIG = JSON.stringify([
      {
        name: 'slack',
        routePath: '/hooks/slack',
        hmacSecret: secret,
        signatureStrategy: 'slack',
        openclawHookUrl: 'http://127.0.0.1:18789/hooks/agent',
      },
    ]);
    resetSettings();
  });

  it('should respond to url_verification challenge', async () => {
    const payload = JSON.stringify({
      type: 'url_verification',
      challenge: 'test-challenge-token-abc123',
      token: 'deprecated-token',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature(secret, timestamp, payload);

    const app = createApp();
    const response = await supertest(app)
      .post('/hooks/slack')
      .set('Content-Type', 'application/json')
      .set('x-slack-signature', signature)
      .set('x-slack-request-timestamp', timestamp)
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ challenge: 'test-challenge-token-abc123' });
  });

  it('should still validate signature before responding to challenge', async () => {
    const payload = JSON.stringify({
      type: 'url_verification',
      challenge: 'test-challenge-token',
    });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const app = createApp();
    const response = await supertest(app)
      .post('/hooks/slack')
      .set('Content-Type', 'application/json')
      .set('x-slack-signature', 'v0=invalid')
      .set('x-slack-request-timestamp', timestamp)
      .send(payload);

    expect(response.status).toBe(401);
  });

  it('should process normal events through the standard flow', async () => {
    const payload = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        ts: '1712345678.123456',
        channel: 'C08V6MV0VNV',
        blocks: [{ text: { text: 'Alert message' } }],
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = computeSlackSignature(secret, timestamp, payload);

    const app = createApp();
    const response = await supertest(app)
      .post('/hooks/slack')
      .set('Content-Type', 'application/json')
      .set('x-slack-signature', signature)
      .set('x-slack-request-timestamp', timestamp)
      .send(payload);

    // No routing rules configured, so it should be accepted but not routed
    expect(response.status).toBe(202);
  });
});
