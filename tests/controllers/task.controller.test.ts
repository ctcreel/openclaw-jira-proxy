import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const { mockCreateTask, mockGetTaskStatus, mockWaitForTask, UnknownAgentErrorMock } = vi.hoisted(
  () => {
    class UnknownAgentErrorMock extends Error {
      constructor(name: string) {
        super(`Unknown agent: ${name}`);
        this.name = 'UnknownAgentError';
      }
    }
    return {
      mockCreateTask: vi.fn(),
      mockGetTaskStatus: vi.fn(),
      mockWaitForTask: vi.fn(),
      UnknownAgentErrorMock,
    };
  },
);

vi.mock('../../src/services/task.service', () => ({
  createTask: mockCreateTask,
  getTaskStatus: mockGetTaskStatus,
  waitForTask: mockWaitForTask,
  UnknownAgentError: UnknownAgentErrorMock,
}));

import {
  createTaskHandler,
  getTaskStatusHandler,
  waitTaskHandler,
} from '../../src/controllers/task.controller';
import { resetSettings } from '../../src/config';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';

const agents: ResolvedAgent[] = [
  { name: 'scarlett', dir: '/agents/scarlett', config: { routing: {}, modelRules: {} } },
];

function buildApp() {
  const app = express();
  app.post('/api/tasks', express.json({ limit: '1mb' }), createTaskHandler(agents));
  app.get('/api/tasks/:agent/:taskId', getTaskStatusHandler());
  app.get('/api/tasks/:agent/:taskId/wait', waitTaskHandler());
  return app;
}

describe('POST /api/tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLAWNDOM_AGENT_TOKEN = 'test-agent-token';
    resetSettings();
  });

  it('401s without a bearer token', async () => {
    const response = await supertest(buildApp())
      .post('/api/tasks')
      .send({ agent: 'scarlett', taskType: 'plan_review' });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Unauthorized');
  });

  it('401s with the wrong bearer token', async () => {
    const response = await supertest(buildApp())
      .post('/api/tasks')
      .set('Authorization', 'Bearer nope')
      .send({ agent: 'scarlett', taskType: 'plan_review' });
    expect(response.status).toBe(401);
  });

  it('400s on a malformed body', async () => {
    const response = await supertest(buildApp())
      .post('/api/tasks')
      .set('Authorization', 'Bearer test-agent-token')
      .send({ taskType: 'plan_review' });
    expect(response.status).toBe(400);
  });

  it('404s when the target agent is unknown', async () => {
    mockCreateTask.mockRejectedValueOnce(new UnknownAgentErrorMock('ghost'));

    const response = await supertest(buildApp())
      .post('/api/tasks')
      .set('Authorization', 'Bearer test-agent-token')
      .send({ agent: 'ghost', taskType: 'plan_review' });
    expect(response.status).toBe(404);
  });

  it('202s with a taskId and URLs on success', async () => {
    mockCreateTask.mockResolvedValueOnce({ taskId: 'task-1', agent: 'scarlett' });

    const response = await supertest(buildApp())
      .post('/api/tasks')
      .set('Authorization', 'Bearer test-agent-token')
      .send({ agent: 'scarlett', taskType: 'plan_review', context: { key: 'SPE-1710' } });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      taskId: 'task-1',
      agent: 'scarlett',
      statusUrl: '/api/tasks/scarlett/task-1',
      waitUrl: '/api/tasks/scarlett/task-1/wait',
    });

    expect(mockCreateTask).toHaveBeenCalledWith(
      { agent: 'scarlett', taskType: 'plan_review', context: { key: 'SPE-1710' } },
      agents,
    );
  });
});

describe('GET /api/tasks/:agent/:taskId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLAWNDOM_AGENT_TOKEN = 'test-agent-token';
    resetSettings();
  });

  it('returns the current task status', async () => {
    mockGetTaskStatus.mockResolvedValueOnce({ taskId: 't-1', status: 'running' });

    const response = await supertest(buildApp())
      .get('/api/tasks/scarlett/t-1')
      .set('Authorization', 'Bearer test-agent-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ taskId: 't-1', status: 'running' });
    expect(mockGetTaskStatus).toHaveBeenCalledWith('scarlett', 't-1');
  });
});

describe('GET /api/tasks/:agent/:taskId/wait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLAWNDOM_AGENT_TOKEN = 'test-agent-token';
    resetSettings();
  });

  it('delegates to waitForTask with the default timeout', async () => {
    mockWaitForTask.mockResolvedValueOnce({ taskId: 't-1', status: 'completed' });

    await supertest(buildApp())
      .get('/api/tasks/scarlett/t-1/wait')
      .set('Authorization', 'Bearer test-agent-token');

    expect(mockWaitForTask).toHaveBeenCalledWith('scarlett', 't-1', 60_000);
  });

  it('honors a custom timeoutMs query param within limits', async () => {
    mockWaitForTask.mockResolvedValueOnce({ taskId: 't-1', status: 'completed' });

    await supertest(buildApp())
      .get('/api/tasks/scarlett/t-1/wait?timeoutMs=120000')
      .set('Authorization', 'Bearer test-agent-token');

    expect(mockWaitForTask).toHaveBeenCalledWith('scarlett', 't-1', 120_000);
  });

  it('clamps oversized timeouts', async () => {
    mockWaitForTask.mockResolvedValueOnce({ taskId: 't-1', status: 'completed' });

    await supertest(buildApp())
      .get('/api/tasks/scarlett/t-1/wait?timeoutMs=999999999')
      .set('Authorization', 'Bearer test-agent-token');

    expect(mockWaitForTask).toHaveBeenCalledWith('scarlett', 't-1', 600_000);
  });
});
