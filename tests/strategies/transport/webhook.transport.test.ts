import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';

import { resetSettings } from '../../../src/config';
import type { WebhookProviderConfig } from '../../../src/config';
import type { ResolvedAgent } from '../../../src/services/agent-loader.service';
import { WebhookTransport } from '../../../src/strategies/transport/webhook.transport';

vi.mock('../../../src/services/queue.service', () => ({
  getProviderQueue: vi.fn(() => ({
    add: vi.fn().mockResolvedValue({ id: 'wt-job-1' }),
  })),
}));

const provider: WebhookProviderConfig = {
  name: 'wt-provider',
  transport: 'webhook',
  routePath: '/hooks/wt',
  hmacSecret: 'wt-secret',
  signatureStrategy: 'websub',
};

const agents: ResolvedAgent[] = [
  {
    name: 'patch',
    dir: '/tmp/wt-agent',
    config: {
      routing: { 'wt-provider': { rules: [{ condition: { all_of: [] } }] } },
      modelRules: {},
    },
  },
];

describe('WebhookTransport', () => {
  beforeEach(() => {
    resetSettings();
  });

  it('mount() registers the configured POST route on the app', async () => {
    const app = express();
    new WebhookTransport(provider, app, agents).mount();

    const res = await supertest(app)
      .post('/hooks/wt')
      .set('Content-Type', 'application/json')
      .set(
        'X-Hub-Signature',
        'sha256=deadbeef00000000000000000000000000000000000000000000000000000000',
      )
      .send('{}');

    expect(res.status).toBe(401);
  });

  it('start() is idempotent — repeated calls only mount once', async () => {
    const app = express();
    const spy = vi.spyOn(app, 'post');
    const transport = new WebhookTransport(provider, app, agents);
    await transport.start();
    await transport.start();
    await transport.start();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('stop() resolves cleanly without doing any teardown', async () => {
    const app = express();
    const transport = new WebhookTransport(provider, app, agents);
    await transport.start();
    await expect(transport.stop()).resolves.toBeUndefined();
  });

  it('exposes the provider name as the transport name', () => {
    const app = express();
    const transport = new WebhookTransport(provider, app, agents);
    expect(transport.name).toBe('wt-provider');
  });
});
