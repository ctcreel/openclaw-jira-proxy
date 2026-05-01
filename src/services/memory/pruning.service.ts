import { getLogger } from '../../lib/logging';

import { getMemoryService } from './memory.service';
import type { NamespaceConfig } from './memory.service';

const logger = getLogger('memory-pruning');

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 10_000;

/**
 * Periodic pruner. Walks every declared namespace once per `intervalMs`
 * (default 24h) and asks the MemoryService to delete entries older than
 * the namespace's configured `pruneAfter`. Each namespace's prune is
 * isolated so one namespace's failure doesn't block the others.
 *
 * The first tick fires `firstDelayMs` after start (default 10s) so a
 * fresh deploy gets a baseline run without waiting a full day. The
 * interval is reset on stop().
 */
export class MemoryPruningScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly namespaces: readonly NamespaceConfig[],
    private readonly intervalMs: number = TWENTY_FOUR_HOURS_MS,
    private readonly firstDelayMs: number = FIRST_TICK_DELAY_MS,
  ) {}

  start(): void {
    if (this.namespaces.length === 0) {
      logger.info('No memory namespaces declared; pruning scheduler will not run');
      return;
    }
    logger.info(
      {
        namespaceCount: this.namespaces.length,
        intervalMs: this.intervalMs,
        firstDelayMs: this.firstDelayMs,
      },
      'Memory pruning scheduler started',
    );
    this.firstTimer = setTimeout(() => {
      void this.runOnce().finally(() => this.scheduleNext());
    }, this.firstDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.firstTimer !== null) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }
  }

  /**
   * Test-only: trigger a single tick synchronously. Useful for asserting
   * that prune fires for each namespace without waiting on real timers.
   */
  async runOnce(): Promise<void> {
    const service = getMemoryService();
    for (const ns of this.namespaces) {
      try {
        const result = await service.prune({ namespace: ns.name });
        logger.info(
          { namespace: ns.name, deletedCount: result.deletedCount, durationMs: result.durationMs },
          'Memory namespace pruned',
        );
      } catch (error) {
        logger.error(
          {
            namespace: ns.name,
            error: error instanceof Error ? error.message : String(error),
          },
          'Memory prune failed for namespace',
        );
      }
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.scheduleNext());
    }, this.intervalMs);
  }
}
