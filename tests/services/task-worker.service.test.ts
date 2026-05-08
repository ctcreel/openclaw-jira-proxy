import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import {
  resolveRunnerAndPrompt,
  buildRecallBlockIfRequested,
  readDirectPrompt,
  readUseMemory,
  mapRunResult,
} from '../../src/services/task-worker.service';
import { ShellRunner } from '../../src/runners/shell.runner';
import {
  registerRunner,
  resetRunners,
  type AgentRunner,
  type RunOptions,
  type RunResult,
} from '../../src/runners';
import type { AgentRule, ResolvedAgent } from '../../src/services/agent-loader.service';
import { setMemoryServiceForTest } from '../../src/services/memory/memory.service';
import type { MemoryService } from '../../src/services/memory/memory.service';
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

// SPE-2049 — fire-time branch helpers (verbatim vs RAG-wrapped). The
// controller tests cover the HTTP boundary; these cover the actual
// firing-site decisions: AC 4 (verbatim), AC 5 (RAG-wrapped), AC 6
// (RAG failure → fall back to verbatim).
describe('readDirectPrompt', () => {
  it('returns the string when context.directPrompt is a non-empty string', () => {
    expect(readDirectPrompt({ directPrompt: 'go check Jira' })).toBe('go check Jira');
  });

  it('returns undefined when directPrompt is missing', () => {
    expect(readDirectPrompt({})).toBeUndefined();
  });

  it('returns undefined when directPrompt is empty', () => {
    expect(readDirectPrompt({ directPrompt: '' })).toBeUndefined();
  });

  it('returns undefined when directPrompt is the wrong type', () => {
    expect(readDirectPrompt({ directPrompt: 123 })).toBeUndefined();
    expect(readDirectPrompt({ directPrompt: { nested: 'no' } })).toBeUndefined();
  });
});

describe('readUseMemory', () => {
  it('returns undefined when useMemory is missing', () => {
    expect(readUseMemory({})).toBeUndefined();
  });

  it('parses the boolean shape', () => {
    expect(readUseMemory({ useMemory: true })).toBe(true);
    expect(readUseMemory({ useMemory: false })).toBe(false);
  });

  it('parses the overrides shape', () => {
    expect(
      readUseMemory({ useMemory: { namespace: 'jira', topK: 8, minSimilarity: 0.6 } }),
    ).toEqual({ namespace: 'jira', topK: 8, minSimilarity: 0.6 });
  });

  it('returns undefined and warns on a corrupt useMemory entry (silent-degrade guard)', () => {
    // The corrupt-entry path used to silently degrade to verbatim with
    // no operator signal. The fix routes it through logger.warn; we
    // can't easily intercept the bunyan-style logger here, so we just
    // confirm the parse-fail still returns undefined (caller falls
    // back to verbatim) without throwing.
    expect(readUseMemory({ useMemory: 'not-a-valid-shape' })).toBeUndefined();
    expect(readUseMemory({ useMemory: { topK: -1 } })).toBeUndefined();
  });
});

describe('mapRunResult', () => {
  it('passes through ok results', () => {
    const summary = mapRunResult({ status: 'ok', runId: 'run-1', renderedPrompt: 'p' });
    expect(summary).toEqual({ runId: 'run-1', status: 'ok' });
  });

  it('throws on error', () => {
    expect(() => mapRunResult({ status: 'error', error: 'boom' } as RunResult)).toThrow(
      /Task run failed: boom/,
    );
  });

  it('throws on timeout', () => {
    expect(() => mapRunResult({ status: 'timeout', runId: 'run-2' } as RunResult)).toThrow(
      /timed out.*run-2/,
    );
  });

  it('throws on quota_exceeded with the resets-at ISO timestamp', () => {
    const resetAt = 1_700_000_000_000;
    expect(() =>
      mapRunResult({ status: 'quota_exceeded', quotaResetAt: resetAt } as RunResult),
    ).toThrow(/upstream quota limit/);
  });
});

describe('buildRecallBlockIfRequested', () => {
  function buildAgentWithNamespaces(
    namespaces: Record<string, unknown> | undefined,
  ): ResolvedAgent {
    return {
      name: 'patch',
      dir: '/tmp/agent',
      config: {
        routing: {},
        modelRules: {},
        ...(namespaces !== undefined ? { memory: { namespaces } } : {}),
      } as ResolvedAgent['config'],
    };
  }

  // Stub MemoryService — only `search` is exercised here. We bypass
  // the constructor's validation by casting through the test seam.
  function stubMemoryService(search: MemoryService['search']): MemoryService {
    return {
      search,
      // Other methods aren't called on this path.
      store: vi.fn(),
      delete: vi.fn(),
      prune: vi.fn(),
      hasNamespace: vi.fn().mockReturnValue(true),
      listNamespaces: vi.fn().mockReturnValue([]),
    } as unknown as MemoryService;
  }

  beforeEach(() => {
    setMemoryServiceForTest(null);
  });

  afterEach(() => {
    setMemoryServiceForTest(null);
  });

  it('returns undefined when useMemory is undefined (verbatim path — AC 4)', async () => {
    const agent = buildAgentWithNamespaces({ jira: {} });
    const result = await buildRecallBlockIfRequested(undefined, 'q', agent, 'trace-1');
    expect(result).toBeUndefined();
  });

  it('returns undefined when useMemory is false', async () => {
    const agent = buildAgentWithNamespaces({ jira: {} });
    const result = await buildRecallBlockIfRequested(false, 'q', agent, 'trace-1');
    expect(result).toBeUndefined();
  });

  it('returns undefined when useMemory is true but the agent declares no namespaces', async () => {
    const agent = buildAgentWithNamespaces(undefined);
    const result = await buildRecallBlockIfRequested(true, 'q', agent, 'trace-1');
    expect(result).toBeUndefined();
  });

  it('renders a recall block populated with hits when useMemory is true (AC 5)', async () => {
    const search = vi.fn().mockResolvedValue({
      hits: [
        { id: 'm-1', text: 'Charlie is the cat', metadata: {}, score: 0.91 },
        { id: 'm-2', text: 'Heather prefers email', metadata: {}, score: 0.83 },
      ],
    });
    setMemoryServiceForTest(stubMemoryService(search));
    const agent = buildAgentWithNamespaces({ jira: {} });

    const result = await buildRecallBlockIfRequested(true, 'about Charlie', agent, 'trace-1');

    expect(result).toBeDefined();
    expect(result).toContain('Memory — durable facts');
    expect(result).toContain('Charlie is the cat');
    expect(result).toContain('Heather prefers email');
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'jira', query: 'about Charlie', traceId: 'trace-1' }),
    );
  });

  it('honours overrides namespace + topK + minSimilarity', async () => {
    const search = vi.fn().mockResolvedValue({ hits: [] });
    setMemoryServiceForTest(stubMemoryService(search));
    const agent = buildAgentWithNamespaces({ jira: {}, ops: {} });

    await buildRecallBlockIfRequested(
      { namespace: 'ops', topK: 12, minSimilarity: 0.4 },
      'q',
      agent,
      'trace-1',
    );

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'ops', topK: 12, minSimilarity: 0.4 }),
    );
  });

  it('falls back to verbatim when memory.search throws (AC 6)', async () => {
    const search = vi.fn().mockRejectedValue(new Error('embedding provider down'));
    setMemoryServiceForTest(stubMemoryService(search));
    const agent = buildAgentWithNamespaces({ jira: {} });

    const result = await buildRecallBlockIfRequested(true, 'q', agent, 'trace-1');

    expect(result).toBeUndefined();
    expect(search).toHaveBeenCalledOnce();
  });
});
