import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAlertProvider } from '../../../src/services/alerts';
import type { JobAlert } from '../../../src/services/alerts';

function makeAlert(overrides?: Partial<JobAlert>): JobAlert {
  return {
    jobId: 'job-1',
    sessionKey: 'hook:jira:job-1',
    agentId: 'patch',
    error: 'Gateway returned 500',
    attempts: 2,
    maxAttempts: 2,
    provider: 'jira',
    failedAt: new Date('2026-03-30T20:00:00Z'),
    ...overrides,
  };
}

describe('DiscordAlertProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should throw if no webhookUrl', () => {
    expect(() => new DiscordAlertProvider({ webhookUrl: '' })).toThrow('requires webhookUrl');
  });

  it('should POST to webhook URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const provider = new DiscordAlertProvider({ webhookUrl: 'https://discord.com/api/webhooks/test' });

    await provider.send(makeAlert());

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/test',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Webhook job failed'),
      }),
    );
  });

  it('should not throw when webhook fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const provider = new DiscordAlertProvider({ webhookUrl: 'https://discord.com/api/webhooks/test' });

    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });

  it('should not throw when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const provider = new DiscordAlertProvider({ webhookUrl: 'https://discord.com/api/webhooks/test' });

    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });
});
