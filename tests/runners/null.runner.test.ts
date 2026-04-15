import { describe, it, expect } from 'vitest';

import { NullRunner } from '../../src/runners/null.runner';
import type { RunOptions } from '../../src/runners/types';

const baseOptions: RunOptions = {
  prompt: 'test prompt',
  sessionKey: 'session-1',
  agentId: 'agent-1',
  timeoutMs: 30_000,
};

describe('NullRunner', () => {
  it('should have name "null"', () => {
    const runner = new NullRunner();
    expect(runner.name).toBe('null');
  });

  it('should return ok status', async () => {
    const runner = new NullRunner();
    const result = await runner.run(baseOptions);
    expect(result.status).toBe('ok');
  });

  it('should capture renderedPrompt from options', async () => {
    const runner = new NullRunner();
    const result = await runner.run({ ...baseOptions, prompt: 'hello world' });
    expect(result.renderedPrompt).toBe('hello world');
  });

  it('should return a runId', async () => {
    const runner = new NullRunner();
    const result = await runner.run(baseOptions);
    expect(result.runId).toMatch(/^null-\d+$/);
  });

  it('should return startedAt and endedAt timestamps', async () => {
    const runner = new NullRunner();
    const result = await runner.run(baseOptions);
    expect(result.startedAt).toBeDefined();
    expect(result.endedAt).toBeDefined();
  });
});
