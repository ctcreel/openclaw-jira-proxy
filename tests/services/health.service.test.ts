import { describe, it, expect } from 'vitest';

import { buildHealthResponse } from '../../src/services/health.service';

describe('buildHealthResponse', () => {
  it('should return healthy status when all checks pass', () => {
    const response = buildHealthResponse();
    expect(response.status).toBe('healthy');
  });

  it('should include timestamp in ISO format', () => {
    const response = buildHealthResponse();
    expect(new Date(response.timestamp).toISOString()).toBe(response.timestamp);
  });
});
