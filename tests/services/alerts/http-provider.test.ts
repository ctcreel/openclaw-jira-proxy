import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpAlertProvider } from '../../../src/services/alerts';
import type { JobAlert } from '../../../src/services/alerts';

function makeAlert(overrides?: Partial<JobAlert>): JobAlert {
  return {
    jobId: 'job-1',
    sessionKey: 'hook:jira:job-1',
    agentId: 'patch',
    error: 'timeout',
    attempts: 2,
    maxAttempts: 2,
    provider: 'jira',
    failedAt: new Date('2026-03-30T20:00:00Z'),
    ...overrides,
  };
}

describe('HttpAlertProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('should throw if no url', () => {
    expect(() => new HttpAlertProvider({ url: '' })).toThrow('requires url');
  });

  it('should POST JSON alert payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const provider = new HttpAlertProvider({ url: 'https://alerts.example.com/webhook' });

    await provider.send(makeAlert());

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://alerts.example.com/webhook');
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      jobId: 'job-1',
      agentId: 'patch',
      error: 'timeout',
    });
  });

  it('should include custom headers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const provider = new HttpAlertProvider({
      url: 'https://alerts.example.com/webhook',
      headers: { Authorization: 'Bearer secret', 'X-Custom': 'value' },
    });

    await provider.send(makeAlert());

    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer secret',
      'X-Custom': 'value',
      'Content-Type': 'application/json',
    });
  });

  it('should not throw when endpoint fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const provider = new HttpAlertProvider({ url: 'https://alerts.example.com/webhook' });

    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });

  it('should not throw when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('DNS failure'));
    const provider = new HttpAlertProvider({ url: 'https://alerts.example.com/webhook' });

    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });
});
