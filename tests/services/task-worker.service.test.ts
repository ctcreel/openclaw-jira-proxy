import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { resolveRunnerAndPrompt } from '../../src/services/task-worker.service';
import { ShellRunner } from '../../src/runners/shell.runner';
import {
  registerRunner,
  resetRunners,
  type AgentRunner,
  type RunOptions,
  type RunResult,
} from '../../src/runners';
import type { AgentRule, ResolvedAgent } from '../../src/services/agent-loader.service';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeRunner implements AgentRunner {
  constructor(public readonly name: string) {}
  async run(_options: RunOptions): Promise<RunResult> {
    return { status: 'ok', renderedPrompt: 'unused', runId: 'fake' };
  }
}

function buildAgent(dir: string): ResolvedAgent {
  return {
    name: 'patch',
    dir,
    config: { routing: {}, modelRules: {} },
  };
}

describe('resolveRunnerAndPrompt', () => {
  let workdir: string;

  beforeEach(async () => {
    resetRunners();
    workdir = await mkdtemp(join(tmpdir(), 'clawndom-task-worker-test-'));
  });

  afterEach(async () => {
    resetRunners();
    await rm(workdir, { recursive: true, force: true });
  });

  it('constructs a ShellRunner per-firing for shell rules and skips template rendering', async () => {
    const rule: AgentRule = {
      name: 'gmail-watch-refresh',
      cron: '0 9 * * 1',
      catchUp: false,
      runner: { type: 'shell', command: 'echo hi', timeoutMs: 60_000 },
    };

    const { runner, prompt } = await resolveRunnerAndPrompt(rule, {}, buildAgent(workdir));

    expect(runner).toBeInstanceOf(ShellRunner);
    expect(runner.name).toBe('shell');
    expect(prompt).toBe('');
  });

  it('falls back to claude-cli runner from the registry when no override is set', async () => {
    registerRunner(new FakeRunner('claude-cli'));
    const templatePath = join(workdir, 'tpl.md');
    await writeFile(templatePath, 'hello {{name}}');

    const rule: AgentRule = {
      name: 'no-runner',
      cron: '0 9 * * *',
      catchUp: false,
      messageTemplate: 'tpl.md',
    };

    const { runner, prompt } = await resolveRunnerAndPrompt(
      rule,
      { name: 'world' },
      buildAgent(workdir),
    );

    expect(runner.name).toBe('claude-cli');
    expect(prompt).toContain('hello world');
  });

  it('honors a non-shell runner override by looking it up in the registry', async () => {
    registerRunner(new FakeRunner('openai'));
    const templatePath = join(workdir, 'tpl.md');
    await writeFile(templatePath, 'static');

    const rule: AgentRule = {
      name: 'override-openai',
      cron: '0 9 * * *',
      catchUp: false,
      messageTemplate: 'tpl.md',
      runner: { type: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
    };

    const { runner, prompt } = await resolveRunnerAndPrompt(rule, {}, buildAgent(workdir));

    expect(runner.name).toBe('openai');
    expect(prompt).toBe('static');
  });

  it('serializes the payload as JSON when no messageTemplate is configured', async () => {
    registerRunner(new FakeRunner('claude-cli'));

    const rule: AgentRule = {
      name: 'no-template',
      cron: '0 9 * * *',
      catchUp: false,
    };

    const { prompt } = await resolveRunnerAndPrompt(
      rule,
      { kind: 'scheduled', rule: 'no-template' },
      buildAgent(workdir),
    );

    const parsed = JSON.parse(prompt);
    expect(parsed).toMatchObject({ kind: 'scheduled', rule: 'no-template' });
  });
});
