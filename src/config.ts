import { z } from 'zod';

import { routingConfigSchema } from './strategies/routing';

const modelRuleSchema = z.object({
  /** Dot-notation field path to match against the webhook payload. */
  field: z.string().min(1),
  /** Value(s) the resolved field must match (string or array of strings). */
  matches: z.union([z.string(), z.array(z.string())]),
  /** Model identifier to use when this rule matches. */
  model: z.string().min(1),
});

export type ModelRule = z.infer<typeof modelRuleSchema>;

const providerSchema = z.object({
  name: z.string().min(1),
  routePath: z.string().min(1),
  hmacSecret: z.string().min(1),
  signatureStrategy: z.enum(['websub', 'github']),
  openclawHookUrl: z.string().url(),
  routing: routingConfigSchema,
  modelRules: z.array(modelRuleSchema).optional(),
});

export type ProviderConfig = z.infer<typeof providerSchema>;

const settingsSchema = z.object({
  nodeEnv: z.enum(['local', 'development', 'testing', 'demo', 'production']).default('development'),
  port: z.coerce.number().default(8792),
  serviceName: z.string().default('clawndom'),
  version: z.string().default('0.2.0'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  logFormat: z.enum(['json', 'human']).default('json'),
  openclawToken: z.string().min(1),
  openclawHookUrl: z.string().default('http://127.0.0.1:18789/hooks/agent'),
  openclawAgentId: z.string().default('patch'),
  redisUrl: z.string().default('redis://127.0.0.1:6379'),
  maxConcurrentRuns: z.coerce.number().min(1).default(1),
  agentWaitTimeoutMs: z.coerce.number().min(0).default(1_800_000),
  jobMaxAttempts: z.coerce.number().min(1).default(2),
  jobBackoffDelayMs: z.coerce.number().min(0).default(5_000),
  sessionsFilePath: z.string().default(''),
  providers: z
    .array(providerSchema)
    .min(1, 'At least one provider must be configured in PROVIDERS_CONFIG'),
});

export type Settings = z.infer<typeof settingsSchema>;

let cachedSettings: Settings | null = null;

function parseProviders(): ProviderConfig[] {
  const raw = process.env.PROVIDERS_CONFIG;
  if (!raw) {
    return [];
  }
  try {
    return JSON.parse(raw) as ProviderConfig[];
  } catch {
    throw new Error('PROVIDERS_CONFIG is not valid JSON');
  }
}

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
    openclawToken: process.env.OPENCLAW_TOKEN,
    openclawHookUrl: process.env.OPENCLAW_HOOK_URL,
    openclawAgentId: process.env.OPENCLAW_AGENT_ID,
    redisUrl: process.env.REDIS_URL,
    maxConcurrentRuns: process.env.MAX_CONCURRENT_RUNS,
    agentWaitTimeoutMs: process.env.AGENT_WAIT_TIMEOUT_MS,
    jobMaxAttempts: process.env.JOB_MAX_ATTEMPTS,
    jobBackoffDelayMs: process.env.JOB_BACKOFF_DELAY_MS,
    sessionsFilePath:
      process.env.SESSIONS_FILE_PATH ||
      `${process.env.HOME}/.openclaw/agents/${process.env.OPENCLAW_AGENT_ID || 'patch'}/sessions/sessions.json`,
    providers: parseProviders(),
  });
  return cachedSettings;
}

export function resetSettings(): void {
  cachedSettings = null;
}
