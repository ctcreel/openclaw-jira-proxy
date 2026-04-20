import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { Job } from 'bullmq';

import type { ProviderConfig } from '../../src/config';
import { resetSettings } from '../../src/config';
import { registerRunner, resetRunners } from '../../src/runners/registry';
import type { AgentRunner, RunOptions, RunResult } from '../../src/runners/types';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { processJob } from '../../src/services/worker.service';

const runSpy = vi.fn<[RunOptions], Promise<RunResult>>().mockResolvedValue({
  status: 'ok',
  runId: 'integration-run-id',
  renderedPrompt: 'mock',
});

class MockOpenClawRunner implements AgentRunner {
  readonly name = 'openclaw';
  async run(options: RunOptions): Promise<RunResult> {
    return runSpy(options);
  }
}

function createFakeJob(data: string, id = 'integration-job-1'): Job<string> {
  return { id, data } as unknown as Job<string>;
}

const provider: ProviderConfig = {
  name: 'integration-test',
  routePath: '/hooks/integration',
  hmacSecret: 'integration-secret',
  signatureStrategy: 'websub',
  openclawHookUrl: 'http://unused',
};

// Catch-all agent so routing resolves for any integration-test webhook.
const agents: ResolvedAgent[] = [
  {
    name: 'patch',
    dir: '/tmp/clawndom-integration-agent',
    config: {
      routing: {
        'integration-test': { rules: [{ condition: { all_of: [] } }] },
      },
      modelRules: {},
    },
  },
];

describe('Worker integration (runner registry)', () => {
  beforeAll(() => {
    process.env.OPENCLAW_TOKEN = 'integration-test-token';
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
    resetRunners();
    registerRunner(new MockOpenClawRunner());
  });

  afterEach(() => {
    runSpy.mockClear();
  });

  beforeEach(() => {
    // Re-register after global setup.ts resetRunners() in beforeEach
    resetRunners();
    registerRunner(new MockOpenClawRunner());
  });

  afterAll(() => {
    delete process.env.OPENCLAW_TOKEN;
    delete process.env.OPENCLAW_AGENT_ID;
    resetSettings();
    resetRunners();
  });

  it('should deliver job prompt via runner with isolated session key', async () => {
    const payload = '{"event":"updated"}';

    await processJob(createFakeJob(payload), provider, agents);

    expect(runSpy).toHaveBeenCalledOnce();
    const call = runSpy.mock.calls[0]!;
    expect(call[0].sessionKey).toContain('integration-test');
    expect(call[0].agentId).toBe('patch');
    expect(call[0].prompt).toBe(payload);
  });

  it('should process multiple jobs sequentially', async () => {
    await processJob(createFakeJob('{"event":"first"}', 'job-1'), provider, agents);
    await processJob(createFakeJob('{"event":"second"}', 'job-2'), provider, agents);

    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(runSpy.mock.calls[0]![0].prompt).toBe('{"event":"first"}');
    expect(runSpy.mock.calls[1]![0].prompt).toBe('{"event":"second"}');
  });

  it('should propagate error status as thrown error', async () => {
    runSpy.mockResolvedValueOnce({
      status: 'error',
      error: 'Something broke',
      renderedPrompt: 'test',
    });

    await expect(processJob(createFakeJob('{}'), provider, agents)).rejects.toThrow(
      'Agent run failed: Something broke',
    );
  });
});
