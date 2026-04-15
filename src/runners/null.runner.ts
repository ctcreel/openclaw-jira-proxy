import type { AgentRunner, RunOptions, RunResult } from './types';

/**
 * No-op runner for testing. Returns a successful result without
 * contacting any external service.
 */
export class NullRunner implements AgentRunner {
  readonly name = 'null';

  async run(options: RunOptions): Promise<RunResult> {
    return {
      status: 'ok',
      runId: `null-${Date.now()}`,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      renderedPrompt: options.prompt,
    };
  }
}
