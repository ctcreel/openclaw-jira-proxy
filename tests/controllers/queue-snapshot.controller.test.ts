import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleQueueSnapshot } from '../../src/controllers/queue-snapshot.controller';
import { resetEventBus } from '../../src/services/event-bus.service';
import { resetActiveJobsRegistry } from '../../src/services/active-jobs.service';
import { resetRecentCompletionsRegistry } from '../../src/services/recent-completions.service';
import { resetSettings } from '../../src/config';
import * as queueModule from '../../src/services/queue.service';

function mountApp(): Express {
  const app = express();
  app.get('/api/queue/snapshot', handleQueueSnapshot);
  return app;
}

describe('GET /api/queue/snapshot (SPE-1976)', () => {
  let server: Server;
  let baseUrl: string;
  let queueSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetEventBus();
    resetActiveJobsRegistry();
    resetRecentCompletionsRegistry();
    resetSettings();
    process.env['PROVIDERS_CONFIG'] = JSON.stringify([
      {
        name: 'test-provider',
        routePath: '/hooks/test',
        hmacSecret: 'test-hmac-secret',
        signatureStrategy: 'websub',
        openclawHookUrl: 'http://127.0.0.1:18789/hooks/test',
      },
    ]);
    queueSpy = vi.spyOn(queueModule, 'getProviderQueue').mockReturnValue({
      getWaiting: vi.fn(async () => []),
    } as unknown as ReturnType<typeof queueModule.getProviderQueue>);

    const app = mountApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    queueSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 200 and the QueueSnapshot shape', async () => {
    const response = await fetch(`${baseUrl}/api/queue/snapshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('active');
    expect(body).toHaveProperty('waiting');
    expect(body).toHaveProperty('recentlyCompleted');
    expect(body).toHaveProperty('latestEventId');
    expect(Array.isArray(body['active'])).toBe(true);
    expect(Array.isArray(body['waiting'])).toBe(true);
    expect(Array.isArray(body['recentlyCompleted'])).toBe(true);
    expect(typeof body['latestEventId']).toBe('number');
  });
});
