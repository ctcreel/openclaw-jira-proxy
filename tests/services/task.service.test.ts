import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => {
  const added: Array<{ name: string; data: string; opts?: { jobId?: string } }> = [];
  const jobs = new Map<
    string,
    { data: string; state: string; returnvalue?: unknown; failedReason?: string }
  >();
  const queueInstances: unknown[] = [];

  class QueueMock {
    constructor() {
      queueInstances.push(this);
    }
    async add(name: string, data: string, opts?: { jobId?: string }) {
      added.push({ name, data, opts });
      const id = opts?.jobId ?? `auto-${added.length}`;
      jobs.set(id, { data, state: 'waiting' });
      return { id };
    }
    async getJob(id: string) {
      const raw = jobs.get(id);
      if (!raw) return undefined;
      return {
        id,
        data: raw.data,
        returnvalue: raw.returnvalue,
        failedReason: raw.failedReason,
        async getState() {
          return raw.state;
        },
        async waitUntilFinished() {
          return raw.returnvalue;
        },
      };
    }
    async close() {
      return undefined;
    }
  }

  class QueueEventsMock {
    async close() {
      return undefined;
    }
  }

  return {
    __queueStore: { added, jobs, queueInstances },
    Queue: QueueMock,
    QueueEvents: QueueEventsMock,
    Worker: vi.fn(),
  };
});

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

import * as bullmqMock from 'bullmq';
import {
  createTask,
  getTaskStatus,
  resetTaskQueues,
  UnknownAgentError,
  buildTaskQueueName,
  parseTaskEnvelope,
} from '../../src/services/task.service';
import { resetSettings } from '../../src/config';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';

interface MockQueueStore {
  added: Array<{ name: string; data: string; opts?: { jobId?: string } }>;
  jobs: Map<string, { data: string; state: string; returnvalue?: unknown; failedReason?: string }>;
  queueInstances: unknown[];
}

const queueStore = (bullmqMock as unknown as { __queueStore: MockQueueStore }).__queueStore;

const sampleAgent: ResolvedAgent = {
  name: 'scarlett',
  dir: '/agents/scarlett',
  config: { routing: {}, modelRules: {} },
};

describe('buildTaskQueueName', () => {
  it('namespaces the queue by agent', () => {
    expect(buildTaskQueueName('patch')).toContain('tasks:patch');
    expect(buildTaskQueueName('scarlett')).toContain('tasks:scarlett');
  });
});

describe('createTask', () => {
  beforeEach(() => {
    resetSettings();
    resetTaskQueues();
    queueStore.added.length = 0;
    queueStore.jobs.clear();
    queueStore.queueInstances.length = 0;
  });

  it('enqueues a task with a generated taskId on the agent queue', async () => {
    const result = await createTask(
      { agent: 'scarlett', taskType: 'plan_review', context: { jira: 'SPE-1710' } },
      [sampleAgent],
    );

    expect(result.agent).toBe('scarlett');
    expect(result.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(queueStore.added).toHaveLength(1);
    const envelope = parseTaskEnvelope(queueStore.added[0]!.data);
    expect(envelope.taskId).toBe(result.taskId);
    expect(envelope.taskType).toBe('plan_review');
    expect(envelope.context).toEqual({ jira: 'SPE-1710' });
  });

  it('throws UnknownAgentError when the target agent is not configured', async () => {
    await expect(
      createTask({ agent: 'unknown', taskType: 'plan_review' }, [sampleAgent]),
    ).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it('defaults context to an empty object when omitted', async () => {
    const result = await createTask({ agent: 'scarlett', taskType: 'plan_review' }, [sampleAgent]);
    const envelope = parseTaskEnvelope(queueStore.added[0]!.data);
    expect(envelope.context).toEqual({});
    expect(result.taskId).toBeTruthy();
  });
});

describe('getTaskStatus', () => {
  beforeEach(() => {
    resetSettings();
    resetTaskQueues();
    queueStore.added.length = 0;
    queueStore.jobs.clear();
    queueStore.queueInstances.length = 0;
  });

  it('returns unknown for a missing task', async () => {
    const status = await getTaskStatus('scarlett', 'does-not-exist');
    expect(status).toEqual({ taskId: 'does-not-exist', status: 'unknown' });
  });

  it('maps BullMQ waiting state to queued', async () => {
    await createTask({ agent: 'scarlett', taskType: 'plan_review' }, [sampleAgent]);
    const taskId = queueStore.added[0]!.opts!.jobId!;
    const status = await getTaskStatus('scarlett', taskId);
    expect(status.status).toBe('queued');
  });

  it('returns completed with returnValue when BullMQ says completed', async () => {
    await createTask({ agent: 'scarlett', taskType: 'plan_review' }, [sampleAgent]);
    const taskId = queueStore.added[0]!.opts!.jobId!;
    const job = queueStore.jobs.get(taskId)!;
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
    const taskId = queueStore.added[0]!.opts!.jobId!;
    const job = queueStore.jobs.get(taskId)!;
    job.state = 'failed';
    job.failedReason = 'runner exploded';
    const status = await getTaskStatus('scarlett', taskId);
    expect(status).toEqual({ taskId, status: 'failed', error: 'runner exploded' });
  });
});
