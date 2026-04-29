import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { runnerConfigSchema } from './runners/types';
import { secretBindingSchema, secretProviderConfigSchema } from './secrets/types';

export const modelRuleSchema = z.object({
  /** Dot-notation field path to match against the webhook payload. */
  field: z.string().min(1),
  /** Value(s) the resolved field must match (string or array of strings). */
  matches: z.union([z.string(), z.array(z.string())]),
  /** Model identifier to use when this rule matches. */
  model: z.string().min(1),
});

export type ModelRule = z.infer<typeof modelRuleSchema>;

const baseProviderSchema = z.object({
  name: z.string().min(1),
  /** Runner configuration. Defaults to openclaw when omitted. */
  runner: runnerConfigSchema.optional(),
  /** Logical secret keys this provider needs (resolved by SecretManager). */
  secrets: z.array(z.string()).optional(),
  /**
   * Logical secret keys to inject into the runner subprocess env.
   * Resolved by SecretManager at job dispatch time and passed via RunOptions.env,
   * with each key upper-snake-cased (e.g. "jira_patch_token" -> "JIRA_PATCH_TOKEN").
   * Templates reference the env var directly; the secret value never appears in
   * the rendered prompt or the conversation transcript.
   */
  envSecrets: z.array(z.string().min(1)).optional(),
  /**
   * Override which context-extraction strategy this provider uses. When omitted,
   * the resolver falls back to `provider.name`. Required for providers whose
   * name doesn't match a registered strategy key (e.g. a `slack-winston`
   * provider that should still use the `slack` extractor).
   */
  contextStrategy: z.enum(['jira', 'github', 'slack']).optional(),
});

const webhookProviderSchema = baseProviderSchema.extend({
  transport: z.literal('webhook'),
  routePath: z.string().min(1),
  hmacSecret: z.string().min(1).optional(),
  signatureStrategy: z.enum(['websub', 'github', 'bearer', 'slack']),
  openclawHookUrl: z.string().url().optional(),
});

const slackSocketProviderSchema = baseProviderSchema.extend({
  transport: z.literal('slack-socket'),
  /** Logical key for the Slack app-level token (xapp-*). Resolved via SecretManager. */
  appTokenSecret: z.string().min(1),
  /** Logical key for the Slack bot token (xoxb-*). Resolved + validated at startup; outbound posting is a separate ticket. */
  botTokenSecret: z.string().min(1),
});

// zod's discriminatedUnion picks the branch from the input's discriminator
// before any defaults run, so `transport` defaulting on the literal won't
// preserve back-compat for existing PROVIDERS_CONFIG entries that omit it.
// The preprocess step injects `transport: 'webhook'` when missing — every
// pre-existing entry parses unchanged.
export const providerSchema = z.preprocess(
  (input) => {
    if (input && typeof input === 'object' && !('transport' in input)) {
      return { ...(input as Record<string, unknown>), transport: 'webhook' };
    }
    return input;
  },
  z.discriminatedUnion('transport', [webhookProviderSchema, slackSocketProviderSchema]),
);

export type ProviderConfig = z.infer<typeof providerSchema>;
export type WebhookProviderConfig = z.infer<typeof webhookProviderSchema>;
export type SlackSocketProviderConfig = z.infer<typeof slackSocketProviderSchema>;

export function isWebhookProvider(provider: ProviderConfig): provider is WebhookProviderConfig {
  return provider.transport === 'webhook';
}

export function isSlackSocketProvider(
  provider: ProviderConfig,
): provider is SlackSocketProviderConfig {
  return provider.transport === 'slack-socket';
}

/**
 * Vendored shared-tools dependency. Cloned at a pinned ref alongside the
 * agent repo so agents can import shared technical primitives (Gmail wrappers,
 * Slack helpers, secret readers) without duplicating them across repos.
 *
 * `ref` should resolve to a tag or commit SHA — branches drift, which defeats
 * the point of pinning. The schema accepts any non-empty string; the loader
 * resolves the ref via `git fetch --tags origin + git reset --hard <ref>` and
 * fails fast if the ref does not exist in the remote.
 */
export const sharedToolsSchema = z.object({
  /** Git URL of the shared-tools repo (e.g. agency-tools). */
  repo: z.string().min(1),
  /** Pinned tag or commit SHA. */
  ref: z.string().min(1),
  /** Subdirectory under the agent's clone where the shared-tools repo lands. */
  path: z.string().min(1).default('agency-tools'),
});

export type SharedToolsConfig = z.infer<typeof sharedToolsSchema>;

export const agentEntrySchema = z.object({
  /** Logical agent name (matches the `agentId` referenced in routing rules). */
  name: z.string().min(1),
  /** Git URL — cloned once per unique repo at startup. */
  repo: z.string().min(1),
  /** Optional subdirectory inside the repo. Useful for monorepos. */
  path: z.string().optional(),
  /** Optional branch, tag, or commit SHA. Defaults to the repo's default branch. */
  ref: z.string().optional(),
  /** Optional shared-tools dependency cloned at a pinned ref. */
  sharedTools: sharedToolsSchema.optional(),
});

export type AgentEntry = z.infer<typeof agentEntrySchema>;

const settingsSchema = z.object({
  nodeEnv: z.enum(['local', 'development', 'testing', 'demo', 'production']).default('development'),
  port: z.coerce.number().default(8792),
  serviceName: z.string().default('clawndom'),
  version: z.string().default('0.2.0'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  logFormat: z.enum(['json', 'human']).default('json'),
  openclawToken: z.string().min(1).optional(),
  openclawHookUrl: z.string().default('http://127.0.0.1:18789/hooks/agent'),
  openclawGatewayWsUrl: z.string().default('ws://127.0.0.1:18789'),
  openclawAgentId: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('patch')),
  redisUrl: z.string().default('redis://127.0.0.1:6379'),
  maxConcurrentRuns: z.coerce.number().min(1).default(1),
  agentWaitTimeoutMs: z.coerce.number().min(0).default(1_800_000),
  jobMaxAttempts: z.coerce.number().min(1).default(5),
  jobBackoffDelayMs: z.coerce.number().min(0).default(5_000),
  /** Webhook dedup window: same provider+contextId+contextStatus inside this window is dropped. */
  dedupTtlSeconds: z.coerce.number().min(1).default(60),
  sessionsFilePath: z.string().default(''),
  providers: z
    .array(providerSchema)
    .min(1, 'At least one provider must be configured in PROVIDERS_CONFIG'),
  /** Local directory where agent repos are cloned. */
  configDir: z.string().default(join(homedir(), '.clawndom', 'agents')),
  /** Agents Clawndom should load from Git at startup. */
  agents: z.array(agentEntrySchema).default([]),
  /** Bearer token agents use to call POST /api/tasks. */
  agentToken: z.string().optional(),
  /** Secret provider backends to register. */
  secretProviders: z.array(secretProviderConfigSchema).optional(),
  /** Secret bindings: map logical keys to vault-specific references. */
  secrets: z.array(secretBindingSchema).optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

let cachedSettings: Settings | null = null;

function parseJsonEnv(envVar: string): unknown[] | undefined {
  const raw = process.env[envVar];
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown[];
  } catch {
    throw new Error(`${envVar} is not valid JSON`);
  }
}

function parseProviders(): ProviderConfig[] {
  const raw = process.env['PROVIDERS_CONFIG'];
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PROVIDERS_CONFIG is not valid JSON');
  }
  return z.array(providerSchema).parse(parsed);
}

export function getSettings(): Settings {
  if (cachedSettings !== null) {
    return cachedSettings;
  }
  cachedSettings = settingsSchema.parse({
    nodeEnv: process.env['NODE_ENV'],
    port: process.env['PORT'],
    serviceName: process.env['SERVICE_NAME'],
    version: process.env['npm_package_version'],
    logLevel: process.env['LOG_LEVEL'],
    logFormat: process.env['LOG_FORMAT'],
    openclawToken: process.env['OPENCLAW_TOKEN'],
    openclawHookUrl: process.env['OPENCLAW_HOOK_URL'],
    openclawGatewayWsUrl: process.env['OPENCLAW_GATEWAY_WS_URL'],
    openclawAgentId: process.env['OPENCLAW_AGENT_ID'],
    redisUrl: process.env['REDIS_URL'],
    maxConcurrentRuns: process.env['MAX_CONCURRENT_RUNS'],
    agentWaitTimeoutMs: process.env['AGENT_WAIT_TIMEOUT_MS'],
    jobMaxAttempts: process.env['JOB_MAX_ATTEMPTS'],
    jobBackoffDelayMs: process.env['JOB_BACKOFF_DELAY_MS'],
    dedupTtlSeconds: process.env['DEDUP_TTL_SECONDS'],
    sessionsFilePath:
      process.env['SESSIONS_FILE_PATH'] ||
      `${process.env['HOME']}/.openclaw/agents/${process.env['OPENCLAW_AGENT_ID'] || 'patch'}/sessions/sessions.json`,
    providers: parseProviders(),
    configDir: process.env['CLAWNDOM_CONFIG_DIR'],
    agents: parseJsonEnv('AGENTS_CONFIG'),
    agentToken: process.env['CLAWNDOM_AGENT_TOKEN'],
    secretProviders: parseJsonEnv('SECRETS_PROVIDERS_CONFIG'),
    secrets: parseJsonEnv('SECRETS_CONFIG'),
  });
  return cachedSettings;
}

export function resetSettings(): void {
  cachedSettings = null;
}
