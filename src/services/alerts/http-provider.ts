import { getLogger } from '../../lib/logging';
import type { AlertProvider, JobAlert } from './types';

const logger = getLogger('alert:http');

export interface HttpAlertConfig {
  /** Target URL to POST alerts to. */
  readonly url: string;
  /** Optional headers (e.g. Authorization). */
  readonly headers?: Record<string, string>;
}

/**
 * Generic HTTP alert provider — POSTs a JSON payload to any URL.
 * Covers PagerDuty, Opsgenie, custom endpoints, etc.
 */
export class HttpAlertProvider implements AlertProvider {
  readonly name = 'http';

  constructor(private readonly config: HttpAlertConfig) {
    if (!config.url) {
      throw new Error('HttpAlertProvider requires url');
    }
  }

  async send(alert: JobAlert): Promise<void> {
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify(alert),
      });

      if (!response.ok) {
        throw new Error(`HTTP alert endpoint returned ${response.status}`);
      }

      logger.info({ jobId: alert.jobId, provider: alert.provider }, 'HTTP alert sent');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error), jobId: alert.jobId },
        'Failed to send HTTP alert',
      );
    }
  }
}
