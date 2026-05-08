/**
 * SPE-2049 — fire-time end-to-end: schedule → fire → assert recall block
 * and verbatim prompt land in the runner input.
 *
 * Covers AC 10 directly: the highest-value test on the ticket per the
 * plan. Drives `processTask` with a stubbed registry, stubbed memory
 * service, and stubbed runner — same shape as the production fire path
 * minus Redis/BullMQ. The contract under test is "what the runner sees"
 * — that's what makes this end-to-end for the user-visible behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Job } from 'bullmq';

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import { processTask } from '../../src/services/task-worker.service';
import {
  registerRunner,
  resetRunners,
  type AgentRunner,
  type RunOptions,
  type RunResult,
} from '../../src/runners';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';
import { setMemoryServiceForTest } from '../../src/services/memory/memory.service';
import type { MemoryService } from '../../src/services/memory/memory.service';
import { setScheduledTasksServiceForTests } from '../../src/services/scheduled-tasks.service';
import type { ScheduledTasksService } from '../../src/services/scheduled-tasks.service';

class CapturingRunner implements AgentRunner {
  readonly name = 'claude-cli';
  readonly received: RunOptions[] = [];

  async run(options: RunOptions): Promise<RunResult> {
    this.received.push(options);
    return { status: 'ok', renderedPrompt: options.prompt, runId: 'mock-run' };
  }
}

function buildAgent(): ResolvedAgent {
  return {
    name: 'patch',
    dir: '/tmp/clawndom-fire-test-agent',
    config: {
      routing: {},
      modelRules: {},
      memory: {
        // First-declared namespace becomes the default per
        // getAgentDefaultMemoryNamespace.
        namespaces: { jira: {} },
      },
    } as ResolvedAgent['config'],
  };
}

function buildJob(envelope: Record<string, unknown>, id = 'job-1'): Job<string> {
  return { id, data: JSON.stringify(envelope) } as unknown as Job<string>;
}

function stubRegistryAlwaysFires(): ScheduledTasksService {
  return {
    recordFire: vi.fn().mockResolvedValue({ shouldFire: true }),
    // Other methods aren't called on the fire path.
    upsert: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    listForAgent: vi.fn(),
  } as unknown as ScheduledTasksService;
}

function stubMemoryWithHit(hitText: string, search?: MemoryService['search']): MemoryService {
  return {
    search:
      search ??
      vi.fn().mockResolvedValue({
        hits: [{ id: 'm-1', text: hitText, metadata: {}, score: 0.9 }],
      }),
    store: vi.fn(),
    delete: vi.fn(),
    prune: vi.fn(),
    hasNamespace: vi.fn().mockReturnValue(true),
    listNamespaces: vi.fn().mockReturnValue(['jira']),
  } as unknown as MemoryService;
}

describe('scheduled task fire-time end-to-end (SPE-2049 AC 10)', () => {
  let runner: CapturingRunner;

  beforeEach(() => {
    resetRunners();
    runner = new CapturingRunner();
    registerRunner(runner);
    setScheduledTasksServiceForTests(stubRegistryAlwaysFires());
    setMemoryServiceForTest(null);
  });

  afterEach(() => {
    resetRunners();
    setMemoryServiceForTest(null);
  });

  it('fires a useMemory:true scheduled task with a recall block above the verbatim prompt', async () => {
    setMemoryServiceForTest(stubMemoryWithHit('Charlie is a black labrador and Chris’s dog'));

    const directPrompt = 'Check whether SPE-2049 has any new comments.';
    const envelope = {
      kind: 'scheduled',
      taskId: 'task-1',
      rule: 'agent-prompt',
      context: {
        directPrompt,
        useMemory: true,
      },
    };

    await processTask(buildJob(envelope), buildAgent());

    expect(runner.received).toHaveLength(1);
    const seen = runner.received[0]!;

    // The runner sees the recall block AND the directPrompt — that's
    // the spec from AC 10.
    expect(seen.prompt).toContain('Memory — durable facts');
    expect(seen.prompt).toContain('Charlie is a black labrador');
    expect(seen.prompt).toContain(directPrompt);
    // Recall block sits ABOVE the prompt (recency-biased tail).
    const recallIdx = seen.prompt.indexOf('Memory — durable facts');
    const promptIdx = seen.prompt.indexOf(directPrompt);
    expect(recallIdx).toBeLessThan(promptIdx);
  });

  it('fires a useMemory-omitted scheduled task as a verbatim prompt with no recall block', async () => {
    setMemoryServiceForTest(stubMemoryWithHit('should not appear'));
    const directPrompt = 'Verbatim — no memory in context.';
    const envelope = {
      kind: 'scheduled',
      taskId: 'task-2',
      rule: 'agent-prompt',
      context: { directPrompt },
    };

    await processTask(buildJob(envelope), buildAgent());

    expect(runner.received).toHaveLength(1);
    const seen = runner.received[0]!;
    expect(seen.prompt).toBe(directPrompt);
    expect(seen.prompt).not.toContain('Memory — durable facts');
  });

  it('falls back to verbatim if the memory service throws (AC 6)', async () => {
    const failingSearch = vi.fn().mockRejectedValue(new Error('embedding-down'));
    setMemoryServiceForTest(stubMemoryWithHit('unused', failingSearch));

    const directPrompt = 'Try RAG, fall back gracefully.';
    const envelope = {
      kind: 'scheduled',
      taskId: 'task-3',
      rule: 'agent-prompt',
      context: { directPrompt, useMemory: true },
    };

    await processTask(buildJob(envelope), buildAgent());

    expect(runner.received).toHaveLength(1);
    expect(runner.received[0]!.prompt).toBe(directPrompt);
    expect(failingSearch).toHaveBeenCalledOnce();
  });
});
