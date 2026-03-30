import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackAlertProvider } from '../../../src/services/alerts';
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

describe('SlackAlertProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should throw if no webhookUrl or token', () => {
    expect(() => new SlackAlertProvider({})).toThrow('requires either webhookUrl or token');
  });

  it('should throw if token without channel', () => {
    expect(() => new SlackAlertProvider({ token: 'xoxb-123' })).toThrow('requires channel');
  });

  it('should send via webhook URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const provider = new SlackAlertProvider({ webhookUrl: 'https://hooks.slack.com/test' });

    await provider.send(makeAlert());

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Webhook job failed'),
      }),
    );
  });

  it('should send via bot token + channel', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    const provider = new SlackAlertProvider({ token: 'xoxb-123', channel: 'C0ALJS0M2NR' });

    await provider.send(makeAlert());

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer xoxb-123',
        }),
      }),
    );
  });

  it('should not throw when webhook returns non-200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const provider = new SlackAlertProvider({ webhookUrl: 'https://hooks.slack.com/test' });

    // Should not throw — errors are swallowed
    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });

  it('should not throw when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const provider = new SlackAlertProvider({ webhookUrl: 'https://hooks.slack.com/test' });

    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });

  it('should not throw when Slack API returns ok:false', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: false, error: 'channel_not_found' }),
    });
    const provider = new SlackAlertProvider({ token: 'xoxb-123', channel: 'C000' });

    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });

  it('should include alert details in the message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const provider = new SlackAlertProvider({ webhookUrl: 'https://hooks.slack.com/test' });

    await provider.send(makeAlert({ jobId: 'job-42', agentId: 'main', error: 'timeout' }));

    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toContain('job-42');
    expect(body.text).toContain('main');
    expect(body.text).toContain('timeout');
  });

  it('should prefer webhookUrl over token when both set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const provider = new SlackAlertProvider({
      webhookUrl: 'https://hooks.slack.com/test',
      token: 'xoxb-123',
      channel: 'C000',
    });

    await provider.send(makeAlert());

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.anything(),
    );
  });
});
