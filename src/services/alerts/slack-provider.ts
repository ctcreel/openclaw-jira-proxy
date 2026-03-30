import { getLogger } from '../../lib/logging';
import type { AlertProvider, JobAlert } from './types';

const logger = getLogger('alert:slack');

export interface SlackAlertConfig {
  /** Bot token (xoxb-...) or incoming webhook URL. */
  readonly token?: string;
  /** Webhook URL (https://hooks.slack.com/...). Preferred over token when set. */
  readonly webhookUrl?: string;
  /** Channel ID (required when using bot token, ignored for webhook URLs). */
  readonly channel?: string;
}

/**
 * Posts job failure alerts to a Slack channel.
 *
 * Supports two modes:
 * - Incoming webhook URL (simplest, no scopes needed)
 * - Bot token + channel ID (uses chat.postMessage)
 */
export class SlackAlertProvider implements AlertProvider {
  readonly name = 'slack';

  constructor(private readonly config: SlackAlertConfig) {
    if (!config.webhookUrl && !config.token) {
      throw new Error('SlackAlertProvider requires either webhookUrl or token');
    }
    if (config.token && !config.channel) {
      throw new Error('SlackAlertProvider requires channel when using bot token');
    }
  }

  async send(alert: JobAlert): Promise<void> {
    const text = this.formatMessage(alert);

    try {
      if (this.config.webhookUrl) {
        await this.sendViaWebhook(text);
      } else {
        await this.sendViaApi(text);
      }
      logger.info({ jobId: alert.jobId, provider: alert.provider }, 'Slack alert sent');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), jobId: alert.jobId },
        'Failed to send Slack alert',
      );
    }
  }

  private formatMessage(alert: JobAlert): string {
    return [
      `🚨 *Webhook job failed* — \`${alert.provider}\``,
      `• Job: \`${alert.jobId}\``,
      `• Agent: \`${alert.agentId}\``,
      `• Session: \`${alert.sessionKey}\``,
      `• Attempts: ${alert.attempts}/${alert.maxAttempts}`,
      `• Error: \`${alert.error}\``,
      `• Time: ${alert.failedAt.toISOString()}`,
    ].join('\n');
  }

  private async sendViaWebhook(text: string): Promise<void> {
    const response = await fetch(this.config.webhookUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error(`Slack webhook returned ${response.status}`);
    }
  }

  private async sendViaApi(text: string): Promise<void> {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.token}`,
      },
      body: JSON.stringify({ channel: this.config.channel, text }),
    });

    if (!response.ok) {
      throw new Error(`Slack API returned ${response.status}`);
    }

    const body = (await response.json()) as { ok: boolean; error?: string };
    if (!body.ok) {
      throw new Error(`Slack API error: ${body.error}`);
    }
  }
}
