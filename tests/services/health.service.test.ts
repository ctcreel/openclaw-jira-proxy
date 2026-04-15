import { describe, it, expect, beforeEach } from 'vitest';

import { buildHealthResponse } from '../../src/services/health.service';
import { registerRunner, resetRunners } from '../../src/runners/registry';
import type { AgentRunner, RunOptions, RunResult } from '../../src/runners/types';

class HealthyRunner implements AgentRunner {
  readonly name = 'test-healthy';
  async run(options: RunOptions): Promise<RunResult> {
    return { status: 'ok', renderedPrompt: options.prompt };
  }
  isHealthy(): boolean {
    return true;
  }
}

class UnhealthyRunner implements AgentRunner {
  readonly name = 'test-unhealthy';
  async run(options: RunOptions): Promise<RunResult> {
    return { status: 'ok', renderedPrompt: options.prompt };
  }
  isHealthy(): boolean {
    return false;
  }
}

class NoHealthRunner implements AgentRunner {
  readonly name = 'test-no-health';
  async run(options: RunOptions): Promise<RunResult> {
    return { status: 'ok', renderedPrompt: options.prompt };
  }
  // No isHealthy method
}

describe('buildHealthResponse', () => {
  beforeEach(() => {
    resetRunners();
  });

  it('should return healthy status when no runners are registered', () => {
    const response = buildHealthResponse();
    expect(response.status).toBe('healthy');
    expect(response.checks).toHaveLength(1);
    expect(response.checks[0]!.name).toBe('application');
  });

  it('should include timestamp in ISO format', () => {
    const response = buildHealthResponse();
    expect(new Date(response.timestamp).toISOString()).toBe(response.timestamp);
  });

  it('should include healthy runner check', () => {
    registerRunner(new HealthyRunner());
    const response = buildHealthResponse();

    const runnerCheck = response.checks.find((check) => check.name === 'runner:test-healthy');
    expect(runnerCheck).toBeDefined();
    expect(runnerCheck!.status).toBe('healthy');
  });

  it('should include degraded runner check when runner is unhealthy', () => {
    registerRunner(new UnhealthyRunner());
    const response = buildHealthResponse();

    const runnerCheck = response.checks.find((check) => check.name === 'runner:test-unhealthy');
    expect(runnerCheck).toBeDefined();
    expect(runnerCheck!.status).toBe('degraded');
  });

  it('should report degraded overall status when any runner is unhealthy', () => {
    registerRunner(new HealthyRunner());
    registerRunner(new UnhealthyRunner());
    const response = buildHealthResponse();

    expect(response.status).toBe('degraded');
  });

  it('should not include check for runners without isHealthy', () => {
    registerRunner(new NoHealthRunner());
    const response = buildHealthResponse();

    const runnerCheck = response.checks.find((check) => check.name === 'runner:test-no-health');
    expect(runnerCheck).toBeUndefined();
  });

  it('should include multiple runner checks', () => {
    registerRunner(new HealthyRunner());
    registerRunner(new UnhealthyRunner());
    const response = buildHealthResponse();

    const runnerChecks = response.checks.filter((check) => check.name.startsWith('runner:'));
    expect(runnerChecks).toHaveLength(2);
  });
});
