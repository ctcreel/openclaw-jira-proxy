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
import { registerRunner } from './runners/registry';
import { NullRunner } from './runners/null.runner';
import { OpenClawRunner } from './runners/openclaw.runner';
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

async function startServer(): Promise<void> {
  setupLogging();
  const logger = getLogger('server');
  const settings = getSettings();

  registerRoutingStrategy(fieldEqualsStrategy);
  registerRoutingStrategy(regexStrategy);
  registerRoutingStrategy(defaultStrategy);

  // ── Secrets ──────────────────────────────────────────────────────────
  // Register secret providers (env is always available)
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

  const secretBindings = settings.secrets ?? [];
  const secretManager = new SecretManager(secretBindings);

  if (secretBindings.length > 0) {
    await secretManager.initialize();
  }

  // Resolve hmacSecret from SecretManager for providers that declared secrets
  for (const provider of settings.providers) {
    if (provider.secrets && !provider.hmacSecret) {
      const hmacKey = provider.secrets.find((key) => key.includes('hmac'));
      if (hmacKey && secretManager.hasSecret(hmacKey)) {
        (provider as Record<string, unknown>).hmacSecret = secretManager.getSecret(hmacKey);
      }
    }
  }

  // ── Runners ──────────────────────────────────────────────────────────
  registerRunner(new NullRunner());

  const neededRunnerTypes = new Set(
    settings.providers.map((provider) => provider.runner?.type ?? 'openclaw'),
  );

  logger.info({ runners: [...neededRunnerTypes] }, 'Registering required runners');

  const runnersWithConnections: AgentRunner[] = [];

  if (neededRunnerTypes.has('openclaw')) {
    const token =
      (settings.openclawToken ?? secretManager.hasSecret('openclaw_token'))
        ? secretManager.getSecret('openclaw_token')
        : undefined;
    if (!token) {
      throw new Error('OPENCLAW_TOKEN is required when any provider uses the openclaw runner');
    }
    const gatewayClient = new GatewayClient(settings.openclawGatewayWsUrl, token);
    const openclawRunner = new OpenClawRunner(gatewayClient);
    registerRunner(openclawRunner);
    runnersWithConnections.push(openclawRunner);
  }

  if (neededRunnerTypes.has('claude-cli')) {
    const cliConfigs = settings.providers
      .filter((provider) => provider.runner?.type === 'claude-cli')
      .map((provider) => provider.runner!);

    const firstConfig = cliConfigs[0]!;
    if (firstConfig.type === 'claude-cli') {
      registerRunner(new ClaudeCliRunner(firstConfig));
    }
  }

  if (neededRunnerTypes.has('openai')) {
    const openaiConfigs = settings.providers
      .filter((provider) => provider.runner?.type === 'openai')
      .map((provider) => provider.runner!);

    const firstConfig = openaiConfigs[0]!;
    if (firstConfig.type === 'openai') {
      registerRunner(new OpenAiRunner(firstConfig));
    }
  }

  if (neededRunnerTypes.has('bedrock')) {
    const bedrockConfigs = settings.providers
      .filter((provider) => provider.runner?.type === 'bedrock')
      .map((provider) => provider.runner!);

    const firstConfig = bedrockConfigs[0]!;
    if (firstConfig.type === 'bedrock') {
      registerRunner(new BedrockRunner(firstConfig));
    }
  }

  for (const runner of runnersWithConnections) {
    if (runner.connect) {
      await runner.connect();
    }
  }

  // ── Workers + HTTP ───────────────────────────────────────────────────
  const alertRegistry = buildAlertRegistry();
  for (const provider of settings.providers) {
    createWorker({ provider, alertRegistry });
  }
  logger.info({ providers: settings.providers.map((p) => p.name) }, 'Workers started');

  const app = createApp();
  const port = settings.port;

  app.listen(port, () => {
    logger.info({ port }, `Server running on port ${port}`);
  });

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

startServer().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
