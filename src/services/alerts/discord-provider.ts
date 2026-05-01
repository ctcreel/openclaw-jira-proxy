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
    const lines: string[] = [];
    if (alert.contextId) {
      const status = alert.contextStatus ? ` (${alert.contextStatus})` : '';
      lines.push(`📌 **${alert.contextId}**${status}`);
      if (alert.contextTitle) {
        lines.push(`> ${alert.contextTitle}`);
      }
    }
    lines.push(
      alert.kind === 'orphaned'
        ? `🚨 **Orphaned webhook job** — \`${alert.provider}\``
        : `🚨 **Webhook job failed** — \`${alert.provider}\``,
    );
    lines.push(`- Job: \`${alert.jobId}\``);
    lines.push(`- Agent: \`${alert.agentId}\``);
    lines.push(`- Session: \`${alert.sessionKey}\``);
    if (alert.kind !== 'orphaned') {
      lines.push(`- Attempts: ${alert.attempts}/${alert.maxAttempts}`);
    }
    lines.push(`- Error: \`${alert.error}\``);
    lines.push(`- Time: ${alert.failedAt.toISOString()}`);
    const content = lines.join('\n');

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
