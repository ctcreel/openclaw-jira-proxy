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
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should throw if no webhookUrl', () => {
    expect(() => new DiscordAlertProvider({ webhookUrl: '' })).toThrow('requires webhookUrl');
  });

  it('should POST to webhook URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const provider = new DiscordAlertProvider({
      webhookUrl: 'https://discord.com/api/webhooks/test',
    });

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
    const provider = new DiscordAlertProvider({
      webhookUrl: 'https://discord.com/api/webhooks/test',
    });

    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });

  it('should not throw when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const provider = new DiscordAlertProvider({
      webhookUrl: 'https://discord.com/api/webhooks/test',
    });

    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });

  it('prepends a context line when contextId is set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const provider = new DiscordAlertProvider({
      webhookUrl: 'https://discord.com/api/webhooks/test',
    });

    await provider.send(
      makeAlert({
        contextId: 'SPE-1977',
        contextTitle: 'Orphan detection',
        contextStatus: 'In Development',
      }),
    );

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.content).toContain('**SPE-1977**');
    expect(body.content).toContain('(In Development)');
    expect(body.content).toContain('Orphan detection');
  });

  it('renders an orphan-specific headline and suppresses Attempts when kind=orphaned', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const provider = new DiscordAlertProvider({
      webhookUrl: 'https://discord.com/api/webhooks/test',
    });

    await provider.send(makeAlert({ kind: 'orphaned', attempts: 0, maxAttempts: 0 }));

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.content).toContain('Orphaned webhook job');
    expect(body.content).not.toContain('Webhook job failed');
    expect(body.content).not.toContain('Attempts:');
  });
});
