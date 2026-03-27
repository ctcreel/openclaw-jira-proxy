import { createApp } from './app';
import { setupLogging } from './lib/logging';
import { getSettings } from './config';
import { getLogger } from './lib/logging';
import { createWorker } from './services/worker.service';

async function startServer(): Promise<void> {
  setupLogging();
  const logger = getLogger('server');
  const settings = getSettings();

  createWorker();
  logger.info('BullMQ worker started');

  const app = createApp();
  const port = settings.port;

  app.listen(port, () => {
    logger.info({ port }, `Server running on port ${port}`);
  });
}

startServer().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
