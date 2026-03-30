import { getLogger } from '../../lib/logging';
import type { AlertProvider, JobAlert } from './types';

const logger = getLogger('alert:log');

/**
 * Default alert provider — logs the failure. Always active.
 */
export class LogAlertProvider implements AlertProvider {
  readonly name = 'log';

  async send(alert: JobAlert): Promise<void> {
    logger.error(
      {
        jobId: alert.jobId,
        sessionKey: alert.sessionKey,
        agentId: alert.agentId,
        provider: alert.provider,
        attempts: alert.attempts,
        maxAttempts: alert.maxAttempts,
        error: alert.error,
      },
      `Job failed after ${alert.attempts}/${alert.maxAttempts} attempts`,
    );
  }
}
