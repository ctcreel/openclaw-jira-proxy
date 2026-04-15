import type { HealthCheck, HealthResponse } from '../types';
import { getSettings } from '../config';
import { getRegisteredRunners } from '../runners/registry';
import { getSecretManager } from '../secrets/manager';

export function buildHealthResponse(): HealthResponse {
  const settings = getSettings();
  const checks: HealthCheck[] = [{ name: 'application', status: 'healthy' }];

  // Add secrets health check
  try {
    const secretManager = getSecretManager();
    const healthy = secretManager.isHealthy();
    checks.push({
      name: 'secrets',
      status: healthy ? 'healthy' : 'degraded',
      message: healthy ? undefined : 'One or more required secrets failed to resolve',
    });
  } catch {
    // SecretManager not initialized — skip (no secrets configured)
  }

  // Add per-runner health checks
  for (const runner of getRegisteredRunners()) {
    if (runner.isHealthy) {
      const healthy = runner.isHealthy();
      checks.push({
        name: `runner:${runner.name}`,
        status: healthy ? 'healthy' : 'degraded',
        message: healthy ? undefined : `${runner.name} runner is not ready`,
      });
    }
  }

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
