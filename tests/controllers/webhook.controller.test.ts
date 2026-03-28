import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';

vi.mock('../../src/config', () => ({
  getSettings: vi.fn(() => ({
    jiraHmacSecret: 'test-secret-key',
    openclawToken: 'test-token',
    openclawHookUrl: 'http://127.0.0.1:18789/hooks/agent',
    redisUrl: 'redis://127.0.0.1:6379',
    agentId: 'patch',
    sessionsFilePath: '/tmp/test-sessions.json',
  })),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/services/queue.service', () => ({
  getQueue: vi.fn(() => ({
    add: mockQueueAdd,
  })),
}));

vi.mock('../../src/lib/logging', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { createApp } from '../../src/app';

function signPayload(payload: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(Buffer.from(payload)).digest('hex');
  return `sha256=${hex}`;
}

describe('webhook.controller', () => {
  const app = createApp();

  beforeEach(() => {
    mockQueueAdd.mockReset().mockResolvedValue(undefined);
  });

  it('accepts a validly-signed webhook and returns 202', async () => {
    const payload = JSON.stringify({ issue: { key: 'SPE-1234' } });
    const signature = signPayload(payload, 'test-secret-key');

    const response = await request(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signature)
      .send(payload);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ accepted: true });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'jira-event',
      payload,
      expect.objectContaining({ jobId: expect.stringMatching(/^jira-[a-f0-9]{16}$/) }),
    );
  });

  it('rejects a request with no signature header (401)', async () => {
    const response = await request(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ issue: { key: 'SPE-999' } }));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Missing signature' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('rejects a request with an invalid signature (401)', async () => {
    const payload = JSON.stringify({ issue: { key: 'SPE-999' } });
    const badSignature = signPayload(payload, 'wrong-secret');

    const response = await request(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', badSignature)
      .send(payload);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid signature' });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('rejects a signature with wrong prefix format (401)', async () => {
    const response = await request(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', 'sha512=abcdef')
      .send(JSON.stringify({ issue: { key: 'SPE-999' } }));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid signature' });
  });

  it('generates a deterministic job ID for deduplication', async () => {
    const payload = JSON.stringify({ issue: { key: 'SPE-DUPE' } });
    const signature = signPayload(payload, 'test-secret-key');

    await request(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signature)
      .send(payload);

    await request(app)
      .post('/')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature', signature)
      .send(payload);

    // Both calls should produce the same jobId.
    const firstJobId = mockQueueAdd.mock.calls[0]?.[2]?.jobId;
    const secondJobId = mockQueueAdd.mock.calls[1]?.[2]?.jobId;
    expect(firstJobId).toBe(secondJobId);
    expect(firstJobId).toMatch(/^jira-[a-f0-9]{16}$/);
  });
});
