import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    add: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { resetQueue } from '../../src/services/queue.service';

describe('Queue Service', () => {
  beforeEach(() => {
    resetQueue();
    vi.clearAllMocks();
  });

  it('should create queue with correct name', async () => {
    const { getQueue } = await import('../../src/services/queue.service');
    const queue = getQueue();
    expect(queue.name).toBe('jira-webhooks');
  });

  it('should return same queue instance on subsequent calls', async () => {
    const { getQueue } = await import('../../src/services/queue.service');
    const first = getQueue();
    const second = getQueue();
    expect(first).toBe(second);
  });
});
