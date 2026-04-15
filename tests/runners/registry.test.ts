import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerRunner,
  getRunner,
  getRegisteredRunners,
  resetRunners,
} from '../../src/runners/registry';
import { NullRunner } from '../../src/runners/null.runner';
import type { AgentRunner, RunOptions, RunResult } from '../../src/runners/types';

class FakeRunner implements AgentRunner {
  readonly name = 'fake';
  async run(options: RunOptions): Promise<RunResult> {
    return { status: 'ok', renderedPrompt: options.prompt };
  }
}

describe('Runner Registry', () => {
  beforeEach(() => {
    resetRunners();
  });

  it('should register and retrieve a runner by name', () => {
    const runner = new NullRunner();
    registerRunner(runner);
    expect(getRunner('null')).toBe(runner);
  });

  it('should throw for unknown runner name', () => {
    expect(() => getRunner('nonexistent')).toThrow('Unknown runner: nonexistent');
  });

  it('should list all registered runners', () => {
    registerRunner(new NullRunner());
    registerRunner(new FakeRunner());
    const runners = getRegisteredRunners();
    expect(runners).toHaveLength(2);
    expect(runners.map((runner) => runner.name)).toContain('null');
    expect(runners.map((runner) => runner.name)).toContain('fake');
  });

  it('should clear all runners on reset', () => {
    registerRunner(new NullRunner());
    resetRunners();
    expect(() => getRunner('null')).toThrow();
    expect(getRegisteredRunners()).toHaveLength(0);
  });

  it('should overwrite runner with same name', () => {
    const first = new NullRunner();
    const second = new NullRunner();
    registerRunner(first);
    registerRunner(second);
    expect(getRunner('null')).toBe(second);
  });
});
