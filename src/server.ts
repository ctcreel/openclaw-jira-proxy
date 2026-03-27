import { createApp } from './app';
import { setupLogging } from './lib/logging';
import { getSettings } from './config';
import { connectDatabase } from './database';
import { getLogger } from './lib/logging';

async function startServer(): Promise<void> {
  setupLogging();
  const logger = getLogger('server');
  const settings = getSettings();

  await connectDatabase();

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
