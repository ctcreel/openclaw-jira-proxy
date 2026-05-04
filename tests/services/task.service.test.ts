import { describe, it, expect, vi, beforeEach } from 'vitest';

import { bullmqMockState, findQueueByName, type BullmqQueueMock } from '../helpers/bullmq-mock';

vi.mock('bullmq', async () => {
  const helper = await import('../helpers/bullmq-mock');
  return helper.bullmqMockModule;
});

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import {
  createTask,
  getTaskStatus,
  resetTaskQueues,
  UnknownAgentError,
  buildTaskQueueName,
  parseTaskEnvelope,
  getTaskQueue,
} from '../../src/services/task.service';
import { resetSettings } from '../../src/config';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';

const sampleAgent: ResolvedAgent = {
  name: 'scarlett',
  dir: '/agents/scarlett',
  config: { routing: {}, modelRules: {} },
};

/**
 * Resolve the per-agent BullmqQueueMock the production module created.
 * Replaces the previous closure-shared `queueStore.added` / `queueStore.jobs`
 * — each agent now owns its own queue with its own per-instance state.
 *
 * Walked every assertion in the prior test file: each one targeted a single
 * agent ('scarlett') and a single queue, so the per-instance access pattern
 * is a 1:1 mapping. No assertion semantics changed.
 */
function queueMockForAgent(agentName: string): BullmqQueueMock {
  const queue = getTaskQueue(agentName) as unknown as BullmqQueueMock;
  return queue;
}

describe('buildTaskQueueName', () => {
  it('namespaces the queue by agent', () => {
    expect(buildTaskQueueName('patch')).toContain('tasks-patch');
    expect(buildTaskQueueName('scarlett')).toContain('tasks-scarlett');
  });

  // BullMQ uses ':' as its internal Redis key separator and refuses to
  // construct a Worker if the queue name contains ':'. The original shape
  // tasks:<agent> tripped this on Scarlett's first startup (SPE-1824).
  // SPE-2002 routes this through `assertBullmqSafeName`, so a regression
  // throws at construction time rather than passing CI green.
  it('never contains a colon', () => {
    expect(buildTaskQueueName('patch')).not.toContain(':');
    expect(buildTaskQueueName('scarlett')).not.toContain(':');
  });

  it('throws when the agent name would produce a colon-bearing queue name', () => {
    expect(() => buildTaskQueueName('bad:agent')).toThrow(
      /BullMQ uses ':' as its Redis key separator/,
    );
  });
});

describe('createTask', () => {
  beforeEach(() => {
    resetSettings();
    resetTaskQueues();
    bullmqMockState.reset();
  });

  it('enqueues a task with a generated taskId on the agent queue', async () => {
    const result = await createTask(
      { agent: 'scarlett', taskType: 'plan_review', context: { jira: 'SPE-1710' } },
      [sampleAgent],
    );

    expect(result.agent).toBe('scarlett');
    expect(result.taskId).toMatch(/^[0-9a-f-]{36}$/);

    const queue = queueMockForAgent('scarlett');
    expect(queue.addCalls).toHaveLength(1);
    const envelope = parseTaskEnvelope(queue.addCalls[0]!.data as string);
    expect(envelope.taskId).toBe(result.taskId);
    expect((envelope as { taskType: string }).taskType).toBe('plan_review');
    expect(envelope.context).toEqual({ jira: 'SPE-1710' });
  });

  it('enqueues on the queue named for the agent', async () => {
    await createTask({ agent: 'scarlett', taskType: 'plan_review' }, [sampleAgent]);

    const queue = findQueueByName(buildTaskQueueName('scarlett'));
    expect(queue).toBeDefined();
    expect(queue!.addCalls).toHaveLength(1);
  });

  it('throws UnknownAgentError when the target agent is not configured', async () => {
    await expect(
      createTask({ agent: 'unknown', taskType: 'plan_review' }, [sampleAgent]),
    ).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it('defaults context to an empty object when omitted', async () => {
    const result = await createTask({ agent: 'scarlett', taskType: 'plan_review' }, [sampleAgent]);
    const queue = queueMockForAgent('scarlett');
    const envelope = parseTaskEnvelope(queue.addCalls[0]!.data as string);
    expect(envelope.context).toEqual({});
    expect(result.taskId).toBeTruthy();
  });
});

describe('getTaskStatus', () => {
  beforeEach(() => {
    resetSettings();
    resetTaskQueues();
    bullmqMockState.reset();
  });

  it('returns unknown for a missing task', async () => {
    const status = await getTaskStatus('scarlett', 'does-not-exist');
    expect(status).toEqual({ taskId: 'does-not-exist', status: 'unknown' });
  });

  it('maps BullMQ waiting state to queued', async () => {
    await createTask({ agent: 'scarlett', taskType: 'plan_review' }, [sampleAgent]);
    const queue = queueMockForAgent('scarlett');
    const taskId = queue.addCalls[0]!.opts!['jobId'] as string;
    const status = await getTaskStatus('scarlett', taskId);
    expect(status.status).toBe('queued');
  });

  it('returns completed with returnValue when BullMQ says completed', async () => {
    await createTask({ agent: 'scarlett', taskType: 'plan_review' }, [sampleAgent]);
    const queue = queueMockForAgent('scarlett');
    const taskId = queue.addCalls[0]!.opts!['jobId'] as string;
    const job = queue.jobs.get(taskId)!;
    job.state = 'completed';
    job.returnvalue = { runId: 'cli-42' };
    const status = await getTaskStatus('scarlett', taskId);
    expect(status).toEqual({
      taskId,
      status: 'completed',
      returnValue: { runId: 'cli-42' },
    });
  });

  it('returns failed with error message when BullMQ says failed', async () => {
    await createTask({ agent: 'scarlett', taskType: 'plan_review' }, [sampleAgent]);
    const queue = queueMockForAgent('scarlett');
    const taskId = queue.addCalls[0]!.opts!['jobId'] as string;
    const job = queue.jobs.get(taskId)!;
    job.state = 'failed';
    job.failedReason = 'runner exploded';
    const status = await getTaskStatus('scarlett', taskId);
    expect(status).toEqual({ taskId, status: 'failed', error: 'runner exploded' });
  });
});
