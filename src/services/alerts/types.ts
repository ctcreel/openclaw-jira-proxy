/**
 * Alert provider interface for job failure notifications.
 *
 * Implementations deliver alerts to external systems (Slack, Discord, HTTP, etc.)
 * when a webhook job exhausts all retries.
 */
export interface JobAlert {
  /** BullMQ job ID. */
  readonly jobId: string;
  /** OpenClaw session key for the failed run. */
  readonly sessionKey: string;
  /** Agent that was targeted. */
  readonly agentId: string;
  /** Error message from the final attempt. */
  readonly error: string;
  /** How many attempts were made. */
  readonly attempts: number;
  /** Maximum attempts configured. */
  readonly maxAttempts: number;
  /** Provider name that sourced the webhook. */
  readonly provider: string;
  /** When the final failure occurred. */
  readonly failedAt: Date;
  /** Inbound context identifier (e.g. Jira issue key) when known. */
  readonly contextId?: string;
  /** Inbound context title when known. */
  readonly contextTitle?: string;
  /** Inbound context status at the time the job was started. */
  readonly contextStatus?: string;
  /** Discriminator: 'final-failure' for retry-exhaustion, 'orphaned' for reaper-detected. */
  readonly kind?: 'final-failure' | 'orphaned';
}

export interface AlertProvider {
  /** Human-readable name (e.g. "slack", "discord", "http"). */
  readonly name: string;

  /**
   * Send an alert. Implementations should not throw — log and swallow errors
   * so a broken alerter never blocks the queue.
   */
  send(alert: JobAlert): Promise<void>;
}
