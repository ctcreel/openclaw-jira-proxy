/**
 * Shared harness for Builder integration tests.
 *
 * Centralises the capturing runner, delivery filtering, polling helper,
 * and per-test marker generator. The duplication this consolidates was
 * tripping SonarCloud's 3% new-code-duplication gate (the dispatch +
 * callback integration tests landed with near-identical shells).
 */
import IORedis from 'ioredis';

import { registerRunner, resetRunners } from '../../../src/runners/registry';
import type { AgentRunner, RunOptions, RunResult } from '../../../src/runners/types';

export interface DeliveredPayload {
  prompt: string;
  agentId: string;
  receivedAt: string;
}

/**
 * Module-scoped delivery store. Each test claims its own deliveries
 * by filtering on a per-test marker embedded in the dispatched
 * payload, so tests sharing the store don't trip over each other.
 */
const allDeliveries: DeliveredPayload[] = [];

export class CapturingRunner implements AgentRunner {
  readonly name = 'openclaw';

  async run(options: RunOptions): Promise<RunResult> {
    allDeliveries.push({
      prompt: options.prompt,
      agentId: options.agentId,
      receivedAt: new Date().toISOString(),
    });
    return {
      status: 'ok',
      runId: `mock-builder-run-${Date.now()}`,
      renderedPrompt: options.prompt,
    };
  }
}

/**
 * Re-register the capturing runner. The repo's global `tests/setup.ts`
 * runs `resetRunners()` in its own `beforeEach`, so every Builder
 * integration test has to re-register before posting a webhook.
 */
export function installCapturingRunner(): void {
  resetRunners();
  registerRunner(new CapturingRunner());
}

/**
 * Wipe the webhook-ingestion dedup cache between Builder integration
 * tests. Builder providers don't carry a context-extraction strategy,
 * so every dispatch resolves to the same `?/?` dedup key — without
 * this, the second test in a file (and onward) silently lands inside
 * the 60-second dedup window and the worker never picks up its job.
 */
export async function clearWebhookDedupKeys(): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  try {
    const keys = await connection.keys('clawndom:dedup:*');
    if (keys.length > 0) {
      await connection.del(...keys);
    }
  } finally {
    await connection.quit();
  }
}

export function getDeliveriesMatching(marker: string): DeliveredPayload[] {
  return allDeliveries.filter((delivery) => delivery.prompt.includes(marker));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let testCounter = 0;
export function nextTestMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${++testCounter}`;
}

/**
 * Poll the delivery store for `count` deliveries containing `marker`.
 * Fails if the count isn't reached within `timeoutMs`. The polling
 * step is 50ms — the worker pickup loop is fast enough that this is
 * usually a single iteration on a warm machine.
 */
export async function waitForDeliveries(
  marker: string,
  count: number,
  timeoutMs = 8000,
): Promise<DeliveredPayload[]> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const matched = getDeliveriesMatching(marker);
    if (matched.length >= count) return matched;
    await sleep(50);
  }
  const finalMatched = getDeliveriesMatching(marker);
  if (finalMatched.length >= count) return finalMatched;
  throw new Error(`Timed out waiting for ${count} deliveries (got ${finalMatched.length})`);
}
