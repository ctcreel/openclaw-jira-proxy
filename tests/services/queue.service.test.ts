import { describe, it, expect, beforeEach } from 'vitest';

import { vi } from 'vitest';
import { bullmqMockState } from '../helpers/bullmq-mock';

vi.mock('bullmq', async () => {
  const helper = await import('../helpers/bullmq-mock');
  return helper.bullmqMockModule;
});

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { resetQueues } from '../../src/services/queue.service';

describe('Queue Service', () => {
  beforeEach(() => {
    resetQueues();
    bullmqMockState.reset();
  });

  it('should create queue with correct provider name', async () => {
    const { getProviderQueue } = await import('../../src/services/queue.service');
    const queue = getProviderQueue('github');
    expect(queue.name).toBe('webhooks-github');
  });

  it('should return same queue instance for same provider', async () => {
    const { getProviderQueue } = await import('../../src/services/queue.service');
    const first = getProviderQueue('github');
    const second = getProviderQueue('github');
    expect(first).toBe(second);
  });

  it('should return different queue instances for different providers', async () => {
    const { getProviderQueue } = await import('../../src/services/queue.service');
    const github = getProviderQueue('github');
    const jira = getProviderQueue('jira');
    expect(github).not.toBe(jira);
    expect(github.name).toBe('webhooks-github');
    expect(jira.name).toBe('webhooks-jira');
  });

  // SPE-2002: confirm the production-side wiring fails fast on a name
  // BullMQ would reject at runtime. The shared mock's constructor calls
  // `assertBullmqSafeName`, so this catches drift in `buildQueueName`.
  it('throws when buildQueueName produces a colon-bearing name', async () => {
    const { buildQueueName } = await import('../../src/services/queue.service');
    expect(() => buildQueueName('bad:provider')).toThrow(
      /BullMQ uses ':' as its Redis key separator/,
    );
  });
});
