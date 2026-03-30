import { describe, it, expect } from 'vitest';
import type { JobAlert, AlertProvider } from '../../../src/services/alerts';

describe('Alert types', () => {
  it('should accept a valid JobAlert', () => {
    const alert: JobAlert = {
      jobId: 'job-1',
      sessionKey: 'hook:jira:job-1',
      agentId: 'patch',
      error: 'Gateway returned 500',
      attempts: 2,
      maxAttempts: 2,
      provider: 'jira',
      failedAt: new Date(),
    };

    expect(alert.jobId).toBe('job-1');
    expect(alert.attempts).toBe(2);
  });

  it('should accept a valid AlertProvider implementation', () => {
    const provider: AlertProvider = {
      name: 'test',
      send: async () => {},
    };

    expect(provider.name).toBe('test');
  });
});
