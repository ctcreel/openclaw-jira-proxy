import { getLogger } from '../../lib/logging';
import type { AlertProvider, JobAlert } from './types';

const logger = getLogger('alert:log');

/**
 * Default alert provider — logs the failure. Always active.
 */
export class LogAlertProvider implements AlertProvider {
  readonly name = 'log';

  async send(alert: JobAlert): Promise<void> {
    const message =
      alert.kind === 'orphaned'
        ? 'Orphaned job — no terminal event'
        : `Job failed after ${alert.attempts}/${alert.maxAttempts} attempts`;
    logger.error(
      {
        jobId: alert.jobId,
        sessionKey: alert.sessionKey,
        agentId: alert.agentId,
        provider: alert.provider,
        attempts: alert.attempts,
        maxAttempts: alert.maxAttempts,
        error: alert.error,
        kind: alert.kind ?? 'final-failure',
        contextId: alert.contextId,
        contextTitle: alert.contextTitle,
        contextStatus: alert.contextStatus,
      },
      message,
    );
  }
}
