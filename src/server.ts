import { createApp } from './app';
import { setupLogging, getLogger } from './lib/logging';
import { getSettings } from './config';
import type { ProviderConfig, Settings } from './config';
import type { Logger } from 'pino';
import { getActiveJobsRegistry } from './services/active-jobs.service';
import { loadAgents } from './services/agent-loader.service';
import type { ResolvedAgent } from './services/agent-loader.service';
import { buildAlertRegistry } from './services/alerts';
import { createTaskWorker } from './services/task-worker.service';
import { createWorker } from './services/worker.service';
import { registerRunner } from './runners/registry';
import { NullRunner } from './runners/null.runner';
import { ClaudeCliRunner } from './runners/claude-cli.runner';
import { OpenAiRunner } from './runners/openai.runner';
import { BedrockRunner } from './runners/bedrock.runner';
import type { AgentRunner } from './runners/types';
import { registerSecretProvider } from './secrets/registry';
import { SecretManager } from './secrets/manager';
import { EnvSecretProvider } from './secrets/env.provider';
import { OnePasswordProvider } from './secrets/onepassword.provider';
import { OAuthSecretProvider } from './secrets/oauth.provider';
import { FileSecretProvider } from './secrets/file.provider';

async function initializeSecrets(settings: Settings): Promise<SecretManager> {
  registerSecretProvider(new EnvSecretProvider());

  if (settings.secretProviders) {
    for (const providerConfig of settings.secretProviders) {
      if (providerConfig.type === 'onepassword') {
        registerSecretProvider(new OnePasswordProvider(providerConfig));
      } else if (providerConfig.type === 'oauth') {
        registerSecretProvider(new OAuthSecretProvider(providerConfig));
      } else if (providerConfig.type === 'file') {
        registerSecretProvider(new FileSecretProvider(providerConfig));
      }
    }
  }

  const bindings = settings.secrets ?? [];
  const manager = new SecretManager(bindings);
  if (bindings.length > 0) {
    await manager.initialize();
  }
  return manager;
}

function resolveProviderHmacSecrets(
  providers: readonly ProviderConfig[],
  secretManager: SecretManager,
): void {
  for (const provider of providers) {
    if (!provider.secrets || provider.hmacSecret) {
      continue;
    }
    const hmacKey = provider.secrets.find((key) => key.includes('hmac'));
    if (hmacKey && secretManager.hasSecret(hmacKey)) {
      provider.hmacSecret = secretManager.getSecret(hmacKey);
    }
  }
}

function resolveOpenClawToken(settings: Settings, secretManager: SecretManager): string {
  const fromSettings = settings.openclawToken;
  if (fromSettings) return fromSettings;
  if (secretManager.hasSecret('openclaw_token')) {
    return secretManager.getSecret('openclaw_token');
  }
  throw new Error('OPENCLAW_TOKEN is required when any provider uses the openclaw runner');
}

async function registerOpenClawRunner(
  settings: Settings,
  secretManager: SecretManager,
): Promise<AgentRunner> {
  const token = resolveOpenClawToken(settings, secretManager);
  // Dynamic import so the openclaw SDK package isn't pulled in on hosts
  // that only use claude-cli / openai / bedrock runners.
  const { GatewayClient } = await import('./services/gateway-client');
  const { OpenClawRunner } = await import('./runners/openclaw.runner');
  const gatewayClient = new GatewayClient(settings.openclawGatewayWsUrl, token);
  const runner = new OpenClawRunner(gatewayClient);
  registerRunner(runner);
  return runner;
}

function registerSingleRunnerByType(
  settings: Settings,
  type: 'claude-cli' | 'openai' | 'bedrock',
): void {
  const config = settings.providers.map((p) => p.runner).find((r) => r?.type === type);
  if (!config) return;
  if (config.type === 'claude-cli') {
    registerRunner(new ClaudeCliRunner(config));
  } else if (config.type === 'openai') {
    registerRunner(new OpenAiRunner(config));
  } else if (config.type === 'bedrock') {
    registerRunner(new BedrockRunner(config));
  }
}

async function registerSelectedRunners(
  settings: Settings,
  secretManager: SecretManager,
  logger: Logger,
): Promise<AgentRunner[]> {
  registerRunner(new NullRunner());

  const neededTypes = new Set(settings.providers.map((p) => p.runner?.type ?? 'openclaw'));
  logger.info({ runners: [...neededTypes] }, 'Registering required runners');

  const runnersWithConnections: AgentRunner[] = [];

  if (neededTypes.has('openclaw')) {
    runnersWithConnections.push(await registerOpenClawRunner(settings, secretManager));
  }
  if (neededTypes.has('claude-cli')) registerSingleRunnerByType(settings, 'claude-cli');
  if (neededTypes.has('openai')) registerSingleRunnerByType(settings, 'openai');
  if (neededTypes.has('bedrock')) registerSingleRunnerByType(settings, 'bedrock');

  for (const runner of runnersWithConnections) {
    if (runner.connect) {
      await runner.connect();
    }
  }
  return runnersWithConnections;
}

function startWorkers(
  providers: readonly ProviderConfig[],
  agents: readonly ResolvedAgent[],
  logger: Logger,
): void {
  // Subscribe the active-jobs registry before any worker can publish
  // job.started — otherwise bootstrap snapshots (GET /api/jobs/active)
  // would miss jobs that started before the first dashboard connects.
  getActiveJobsRegistry();

  const alertRegistry = buildAlertRegistry();
  for (const provider of providers) {
    createWorker({ provider, agents, alertRegistry });
  }
  logger.info({ providers: providers.map((p) => p.name) }, 'Workers started');

  // Task workers — one per agent that declares internal routing rules
  const taskWorkers = agents.map((agent) => createTaskWorker(agent)).filter((w) => w !== null);
  if (taskWorkers.length > 0) {
    logger.info(
      { agents: taskWorkers.length },
      'Task workers started for agents with internal routing rules',
    );
  }
}

function installShutdownHandlers(
  secretManager: SecretManager,
  runnersWithConnections: readonly AgentRunner[],
  logger: Logger,
): void {
  const shutdown = (): void => {
    logger.info('Shutting down...');
    secretManager.close();
    for (const runner of runnersWithConnections) {
      if (runner.close) {
        runner.close().catch(() => {});
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function startServer(): Promise<void> {
  setupLogging();
  const logger = getLogger('server');
  const settings = getSettings();

  const secretManager = await initializeSecrets(settings);
  resolveProviderHmacSecrets(settings.providers, secretManager);

  const runnersWithConnections = await registerSelectedRunners(settings, secretManager, logger);

  const agents = await loadAgents(settings.agents, settings.configDir);
  logger.info(
    { agents: agents.map((agent) => ({ name: agent.name, dir: agent.dir })) },
    'Agents loaded',
  );

  startWorkers(settings.providers, agents, logger);

  const app = createApp(agents);
  app.listen(settings.port, () => {
    logger.info({ port: settings.port }, `Server running on port ${settings.port}`);
  });

  installShutdownHandlers(secretManager, runnersWithConnections, logger);
}

try {
  await startServer();
} catch (error: unknown) {
  console.error('Failed to start server:', error);
  process.exit(1);
}
