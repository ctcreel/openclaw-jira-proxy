import serverlessExpress from '@vendia/serverless-express';

import { createApp } from './app';
import { setupLogging } from './lib/logging';
import { connectDatabase } from './database';

setupLogging();

const app = createApp();

let serverlessExpressInstance: unknown = null;

// noqa: NAMING001 - AWS Lambda convention
export async function handler(
  event: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<unknown> {
  if (serverlessExpressInstance === null) {
    await connectDatabase();
    serverlessExpressInstance = serverlessExpress({ app });
  }
  return (serverlessExpressInstance as (event: unknown, context: unknown) => Promise<unknown>)(
    event,
    context,
  );
}
