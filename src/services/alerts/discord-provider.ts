import { getLogger } from '../../lib/logging';
import type { AlertProvider, JobAlert } from './types';

const logger = getLogger('alert:discord');

export interface DiscordAlertConfig {
  /** Discord webhook URL. */
  readonly webhookUrl: string;
}

/**
 * Posts job failure alerts to a Discord channel via webhook.
 */
export class DiscordAlertProvider implements AlertProvider {
  readonly name = 'discord';

  constructor(private readonly config: DiscordAlertConfig) {
    if (!config.webhookUrl) {
      throw new Error('DiscordAlertProvider requires webhookUrl');
    }
  }

  async send(alert: JobAlert): Promise<void> {
    const content = [
      `🚨 **Webhook job failed** — \`${alert.provider}\``,
      `- Job: \`${alert.jobId}\``,
      `- Agent: \`${alert.agentId}\``,
      `- Session: \`${alert.sessionKey}\``,
      `- Attempts: ${alert.attempts}/${alert.maxAttempts}`,
      `- Error: \`${alert.error}\``,
      `- Time: ${alert.failedAt.toISOString()}`,
    ].join('\n');

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        throw new Error(`Discord webhook returned ${response.status}`);
      }

      logger.info({ jobId: alert.jobId, provider: alert.provider }, 'Discord alert sent');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), jobId: alert.jobId },
        'Failed to send Discord alert',
      );
    }
  }
}
