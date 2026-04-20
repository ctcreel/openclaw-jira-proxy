import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { listActiveJobs } from '../../src/controllers/active-jobs.controller';
import {
  getActiveJobsRegistry,
  resetActiveJobsRegistry,
} from '../../src/services/active-jobs.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';

function mountApp(): Express {
  const app = express();
  app.get('/api/jobs/active', listActiveJobs);
  return app;
}

describe('GET /api/jobs/active', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    resetEventBus();
    resetActiveJobsRegistry();
    const app = mountApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns an empty list when no jobs are active', async () => {
    getActiveJobsRegistry();
    const response = await fetch(`${baseUrl}/api/jobs/active`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobs: [] });
  });

  it('returns active jobs with merged webhook context', async () => {
    getActiveJobsRegistry();
    const bus = getEventBus();

    bus.publish({
      type: 'webhook.accepted',
      timestamp: 10,
      traceId: 'trace-1',
      provider: 'jira',
      contextId: 'SPE-42',
      contextTitle: 'Fix the thing',
      contextStatus: 'In Development',
    });
    bus.publish({
      type: 'job.started',
      timestamp: 11,
      traceId: 'trace-1',
      jobId: 'job-1',
      provider: 'jira',
      agentId: 'patch',
      runner: 'claude-cli',
    });

    const response = await fetch(`${baseUrl}/api/jobs/active`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { jobs: unknown[] };
    expect(body.jobs).toEqual([
      {
        jobId: 'job-1',
        traceId: 'trace-1',
        provider: 'jira',
        agentId: 'patch',
        template: null,
        runner: 'claude-cli',
        model: null,
        startedAt: 11,
        context: { id: 'SPE-42', title: 'Fix the thing', status: 'In Development' },
      },
    ]);
  });
});
