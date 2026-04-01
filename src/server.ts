import { createApp } from './app';
import { setupLogging } from './lib/logging';
import { getSettings } from './config';
import { getLogger } from './lib/logging';
import { buildAlertRegistry } from './services/alerts';
import { GatewayClient } from './services/gateway-client';
import { createWorker } from './services/worker.service';
import {
  registerRoutingStrategy,
  fieldEqualsStrategy,
  regexStrategy,
  defaultStrategy,
} from './strategies/routing';

async function startServer(): Promise<void> {
  setupLogging();
  const logger = getLogger('server');
  const settings = getSettings();

  registerRoutingStrategy(fieldEqualsStrategy);
  registerRoutingStrategy(regexStrategy);
  registerRoutingStrategy(defaultStrategy);

  const gatewayClient = new GatewayClient(settings.openclawGatewayWsUrl, settings.openclawToken);

  const alertRegistry = buildAlertRegistry();
  for (const provider of settings.providers) {
    createWorker({ provider, gatewayClient, alertRegistry });
  }
  logger.info({ providers: settings.providers.map((p) => p.name) }, 'Workers started');

  const app = createApp();
  const port = settings.port;

  app.listen(port, () => {
    logger.info({ port }, `Server running on port ${port}`);
  });

  const shutdown = (): void => {
    logger.info('Shutting down...');
    gatewayClient.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
