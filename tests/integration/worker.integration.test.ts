import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';

import type { ProviderConfig } from '../../src/config';
import { resetSettings } from '../../src/config';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
  })),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/services/session-monitor.service', () => ({
  waitForSessionIdle: vi.fn().mockResolvedValue(undefined),
}));

import { processJob } from '../../src/services/worker.service';

function createFakeJob(data: string, id = 'integration-job-1'): Job<string> {
  return { id, data } as unknown as Job<string>;
}

const provider: ProviderConfig = {
  name: 'integration-test',
  routePath: '/hooks/integration',
  hmacSecret: 'integration-secret',
  signatureStrategy: 'websub',
  openclawHookUrl: 'http://unused',
};

describe('Worker integration (gateway HTTP)', () => {
  let mockGateway: Server;
  let receivedBodies: string[];
  let runCounter: number;

  beforeAll(() => {
    receivedBodies = [];
    runCounter = 0;

    mockGateway = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/hooks/agent') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          receivedBodies.push(Buffer.concat(chunks).toString());
          runCounter++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, runId: `run-${runCounter}` }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    mockGateway.listen(0);
    const port = (mockGateway.address() as AddressInfo).port;
    process.env.OPENCLAW_HOOK_URL = `http://127.0.0.1:${port}/hooks/agent`;
    process.env.OPENCLAW_AGENT_ID = 'patch';
    resetSettings();
  });

  afterEach(() => {
    receivedBodies = [];
    runCounter = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      mockGateway.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('should POST job data to gateway and resolve on 200', async () => {
    const payload = '{"event":"updated"}';

    await processJob(createFakeJob(payload), provider);

    expect(receivedBodies).toHaveLength(1);
    const envelope = JSON.parse(receivedBodies[0]);
    expect(envelope.message).toBe(payload);
  });

  it('should process multiple jobs sequentially', async () => {
    await processJob(createFakeJob('{"event":"first"}', 'job-1'), provider);
    await processJob(createFakeJob('{"event":"second"}', 'job-2'), provider);

    expect(receivedBodies).toHaveLength(2);
    expect(JSON.parse(receivedBodies[0]).message).toBe('{"event":"first"}');
    expect(JSON.parse(receivedBodies[1]).message).toBe('{"event":"second"}');
  });
});
