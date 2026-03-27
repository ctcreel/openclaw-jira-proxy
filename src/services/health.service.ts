import type { HealthCheck, HealthResponse } from '../types';
import { getSettings } from '../config';

export function buildHealthResponse(): HealthResponse {
  const settings = getSettings();
  const checks: HealthCheck[] = [{ name: 'application', status: 'healthy' }];

  const overallStatus = computeOverallStatus(checks);

  return {
    status: overallStatus,
    checks,
    version: settings.version,
    environment: settings.nodeEnv,
    timestamp: new Date().toISOString(),
  };
}

function computeOverallStatus(
  checks: readonly HealthCheck[],
): 'healthy' | 'degraded' | 'unhealthy' {
  if (checks.some((check) => check.status === 'unhealthy')) return 'unhealthy';
  if (checks.some((check) => check.status === 'degraded')) return 'degraded';
  return 'healthy';
}
