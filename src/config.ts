import { z } from 'zod';

const settingsSchema = z.object({
  nodeEnv: z.enum(['local', 'development', 'testing', 'demo', 'production']).default('development'),
  port: z.coerce.number().default(8000),
  serviceName: z.string().default('sc0red-api'),
  version: z.string().default('0.1.0'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  logFormat: z.enum(['json', 'human']).default('json'),
  database: z.object({
    host: z.string().default('localhost'),
    user: z.string().default(''),
    password: z.string().default(''),
    name: z.string().default('sc0red-development'),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (cachedSettings !== null) {
    return cachedSettings;
  }
  cachedSettings = settingsSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    serviceName: process.env.SERVICE_NAME,
    version: process.env.npm_package_version,
    logLevel: process.env.LOG_LEVEL,
    logFormat: process.env.LOG_FORMAT,
    database: {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      name: process.env.DB_NAME,
    },
  });
  return cachedSettings;
}

export function resetSettings(): void {
  cachedSettings = null;
}
