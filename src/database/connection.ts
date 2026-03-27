import mongoose from 'mongoose';

import { getSettings } from '../config';
import { getLogger } from '../lib/logging';

const logger = getLogger('database');

export async function connectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    logger.debug('Reusing existing database connection');
    return;
  }

  const settings = getSettings();
  const { host, user, password, name } = settings.database;

  const connectionString =
    user && password
      ? `mongodb+srv://${user}:${password}@${host}/${name}`
      : `mongodb://${host}/${name}`;

  const isLambda = settings.nodeEnv !== 'local';

  await mongoose.connect(connectionString, {
    minPoolSize: isLambda ? 0 : 2,
    maxPoolSize: isLambda ? 5 : 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  logger.info({ database: name }, 'Database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  logger.info('Database disconnected');
}
