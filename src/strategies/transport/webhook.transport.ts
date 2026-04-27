import express from 'express';
import type { Express } from 'express';

import type { WebhookProviderConfig } from '../../config';
import { createWebhookHandler } from '../../controllers/webhook.controller';
import type { ResolvedAgent } from '../../services/agent-loader.service';
import { getLogger } from '../../lib/logging';

import type { Transport } from './types';

const logger = getLogger('webhook-transport');

/**
 * HTTP webhook transport. Registers `POST {provider.routePath}` on the
 * shared Express app. The actual listening socket is owned by the server
 * (`app.listen`), so `stop()` is intentionally a no-op — the server's
 * shutdown handlers close the listener.
 */
export class WebhookTransport implements Transport {
  readonly name: string;
  private started = false;

  constructor(
    private readonly provider: WebhookProviderConfig,
    private readonly app: Express,
    private readonly agents: readonly ResolvedAgent[],
  ) {
    this.name = provider.name;
  }

  /**
   * Synchronous route mount. Called directly from {@link registerRoutes} so
   * that test setups using `createApp(agents)` get webhook routes for free,
   * and from {@link start} so the production `startTransports` flow stays
   * symmetric with `SlackSocketTransport.start()`.
   */
  mount(): void {
    if (this.started) {
      return;
    }
    this.app.post(
      this.provider.routePath,
      express.raw({ type: 'application/json', limit: '10mb' }),
      createWebhookHandler(this.provider, this.agents),
    );
    this.started = true;
    logger.info(
      { provider: this.provider.name, routePath: this.provider.routePath },
      'Webhook transport mounted',
    );
  }

  async start(): Promise<void> {
    this.mount();
  }

  async stop(): Promise<void> {
    // Express closes routes when the underlying server closes. No
    // per-route teardown needed.
  }
}
