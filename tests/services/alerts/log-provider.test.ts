import { describe, it, expect, vi } from 'vitest';
import { LogAlertProvider } from '../../../src/services/alerts';
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

describe('LogAlertProvider', () => {
  it('should have name "log"', () => {
    const provider = new LogAlertProvider();
    expect(provider.name).toBe('log');
  });

  it('should resolve without throwing', async () => {
    const provider = new LogAlertProvider();
    await expect(provider.send(makeAlert())).resolves.toBeUndefined();
  });
});
