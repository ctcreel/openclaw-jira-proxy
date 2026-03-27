import { z } from 'zod';

const settingsSchema = z.object({
  nodeEnv: z.enum(['local', 'development', 'testing', 'demo', 'production']).default('development'),
  port: z.coerce.number().default(8792),
  serviceName: z.string().default('openclaw-jira-proxy'),
  version: z.string().default('0.1.0'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  logFormat: z.enum(['json', 'human']).default('json'),
  jiraHmacSecret: z.string().min(1),
  openclawToken: z.string().min(1),
  openclawHookUrl: z.string().default('http://127.0.0.1:18789/hooks/jira'),
  redisUrl: z.string().default('redis://127.0.0.1:6379'),
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
    jiraHmacSecret: process.env.JIRA_HMAC_SECRET,
    openclawToken: process.env.OPENCLAW_TOKEN,
    openclawHookUrl: process.env.OPENCLAW_HOOK_URL,
    redisUrl: process.env.REDIS_URL,
  });
  return cachedSettings;
}

export function resetSettings(): void {
  cachedSettings = null;
}
