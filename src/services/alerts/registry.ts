import { getLogger } from '../../lib/logging';
import { DiscordAlertProvider } from './discord-provider';
import { HttpAlertProvider } from './http-provider';
import { LogAlertProvider } from './log-provider';
import { SlackAlertProvider } from './slack-provider';
import type { AlertProvider, JobAlert } from './types';

const logger = getLogger('alert:registry');

/**
 * Holds all configured alert providers and fans out alerts to each one.
 *
 * LogAlertProvider is always included. Additional providers are added
 * based on ALERT_* env vars.
 */
export class AlertRegistry {
  private readonly providers: AlertProvider[] = [];

  constructor(providers?: AlertProvider[]) {
    if (providers) {
      this.providers = providers;
      return;
    }
    // Always log
    this.providers.push(new LogAlertProvider());
  }

  add(provider: AlertProvider): void {
    this.providers.push(provider);
    logger.info({ provider: provider.name }, 'Alert provider registered');
  }

  /** Send an alert to all registered providers. Never throws. */
  async sendAll(alert: JobAlert): Promise<void> {
    await Promise.allSettled(this.providers.map((p) => p.send(alert)));
  }

  get count(): number {
    return this.providers.length;
  }

  get names(): string[] {
    return this.providers.map((p) => p.name);
  }
}

/**
 * Build the alert registry from environment variables.
 *
 * Env vars:
 *   ALERT_SLACK_WEBHOOK_URL   — Slack incoming webhook URL
 *   ALERT_SLACK_TOKEN         — Slack bot token (xoxb-...)
 *   ALERT_SLACK_CHANNEL       — Slack channel ID (required with bot token)
 *   ALERT_DISCORD_WEBHOOK_URL — Discord webhook URL
 *   ALERT_HTTP_URL            — Generic HTTP endpoint
 *   ALERT_HTTP_HEADERS        — JSON-encoded headers for HTTP provider
 */
export function buildAlertRegistry(): AlertRegistry {
  const registry = new AlertRegistry();

  // Misconfigured env vars fail loud at startup — better to crash than
  // to silently ship with a half-dead alert registry that only surfaces
  // the problem when something actually breaks.

  const slackWebhookUrl = process.env.ALERT_SLACK_WEBHOOK_URL;
  const slackToken = process.env.ALERT_SLACK_TOKEN;
  const slackChannel = process.env.ALERT_SLACK_CHANNEL;
  if (slackWebhookUrl || slackToken) {
    registry.add(
      new SlackAlertProvider({
        webhookUrl: slackWebhookUrl,
        token: slackToken,
        channel: slackChannel,
      }),
    );
  }

  const discordWebhookUrl = process.env.ALERT_DISCORD_WEBHOOK_URL;
  if (discordWebhookUrl) {
    registry.add(new DiscordAlertProvider({ webhookUrl: discordWebhookUrl }));
  }

  const httpUrl = process.env.ALERT_HTTP_URL;
  if (httpUrl) {
    const rawHeaders = process.env.ALERT_HTTP_HEADERS;
    const headers = rawHeaders ? (JSON.parse(rawHeaders) as Record<string, string>) : undefined;
    registry.add(new HttpAlertProvider({ url: httpUrl, headers }));
  }

  logger.info({ providers: registry.names }, 'Alert registry initialized');
  return registry;
}
