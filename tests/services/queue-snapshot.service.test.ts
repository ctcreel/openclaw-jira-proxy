import { describe, it, expect, beforeEach, vi } from 'vitest';

import { buildQueueSnapshot } from '../../src/services/queue-snapshot.service';
import { getEventBus, resetEventBus } from '../../src/services/event-bus.service';
import {
  getActiveJobsRegistry,
  resetActiveJobsRegistry,
} from '../../src/services/active-jobs.service';
import {
  getRecentCompletionsRegistry,
  resetRecentCompletionsRegistry,
} from '../../src/services/recent-completions.service';
import { resetSettings } from '../../src/config';
import * as queueModule from '../../src/services/queue.service';

const PROVIDER_TWO_NAME = 'second-provider';

describe('buildQueueSnapshot (SPE-1976)', () => {
  beforeEach(() => {
    resetEventBus();
    resetActiveJobsRegistry();
    resetRecentCompletionsRegistry();
    resetSettings();
    process.env['PROVIDERS_CONFIG'] = JSON.stringify([
      {
        name: 'test-provider',
        routePath: '/hooks/test',
        hmacSecret: 'test-hmac-secret',
        signatureStrategy: 'websub',
        openclawHookUrl: 'http://127.0.0.1:18789/hooks/test',
      },
      {
        name: PROVIDER_TWO_NAME,
        routePath: '/hooks/two',
        hmacSecret: 'test-hmac-secret',
        signatureStrategy: 'websub',
        openclawHookUrl: 'http://127.0.0.1:18789/hooks/two',
      },
    ]);
  });

  it('composes active, waiting, recentlyCompleted, and the latest event id', async () => {
    // Active jobs registry: subscribe BEFORE publishing.
    const active = getActiveJobsRegistry();
    const recent = getRecentCompletionsRegistry();
    const bus = getEventBus();

    bus.publish({
      type: 'webhook.accepted',
      timestamp: 1,
      traceId: 'trace-1',
      provider: 'jira',
      contextId: 'SPE-1',
      contextTitle: 'Active task',
      contextStatus: 'In Development',
    });
    bus.publish({
      type: 'job.started',
      timestamp: 2,
      traceId: 'trace-1',
      jobId: 'job-1',
      provider: 'jira',
      agentId: 'patch',
      runner: 'claude-cli',
    });

    bus.publish({
      type: 'webhook.accepted',
      timestamp: 3,
      traceId: 'trace-2',
      provider: 'jira',
      contextId: 'SPE-2',
      contextTitle: 'Done task',
      contextStatus: 'Verified in Development',
    });
    bus.publish({
      type: 'job.started',
      timestamp: 4,
      traceId: 'trace-2',
      jobId: 'job-2',
      provider: 'jira',
      agentId: 'patch',
      runner: 'claude-cli',
    });
    bus.publish({
      type: 'job.completed',
      timestamp: 5,
      traceId: 'trace-2',
      jobId: 'job-2',
      provider: 'jira',
      durationMs: 100,
      runId: 'run-2',
    });

    // Mock BullMQ getWaiting per provider.
    const getWaiting = vi.fn(async (start: number, end: number) => {
      void start;
      void end;
      return [
        {
          id: 'waiting-1',
          timestamp: 1234,
          name: 'webhook-event',
        },
      ] as unknown[];
    });
    const queueMock = { getWaiting } as unknown as ReturnType<typeof queueModule.getProviderQueue>;
    const spy = vi.spyOn(queueModule, 'getProviderQueue').mockReturnValue(queueMock);

    try {
      const snapshot = await buildQueueSnapshot();

      // active should include job-1, exclude job-2 (completed)
      expect(snapshot.active.map((j) => j.jobId)).toEqual(['job-1']);

      // recentlyCompleted should include job-2 only
      expect(snapshot.recentlyCompleted.map((c) => c.jobId)).toEqual(['job-2']);

      // waiting should have 1 entry per provider — 2 providers in PROVIDERS_CONFIG
      expect(snapshot.waiting).toHaveLength(2);
      expect(snapshot.waiting.every((w) => w.jobId === 'waiting-1')).toBe(true);
      expect(new Set(snapshot.waiting.map((w) => w.provider))).toEqual(
        new Set(['test-provider', PROVIDER_TWO_NAME]),
      );

      // latestEventId mirrors what the bus has stamped.
      expect(snapshot.latestEventId).toBe(bus.getLatestId());
      expect(snapshot.latestEventId).toBeGreaterThan(0);

      // Force the registries to be referenced so unused-import lint is happy
      // and to confirm the singletons we seeded ARE the ones the snapshot reads.
      expect(snapshot.active.length).toBe(active.listActive().length);
      expect(snapshot.recentlyCompleted.length).toBe(recent.list().length);
    } finally {
      spy.mockRestore();
    }
  });

  it('fans getWaiting across all providers in parallel', async () => {
    // Subscribe registries first so they receive events.
    getActiveJobsRegistry();
    getRecentCompletionsRegistry();

    const callOrder: string[] = [];
    const release: Record<string, (jobs: unknown[]) => void> = {};

    const getWaiting = vi.fn(async function (this: { name?: string }) {
      const providerName = this?.name ?? 'unknown';
      callOrder.push(providerName);
      return new Promise<unknown[]>((resolve) => {
        release[providerName] = resolve;
      });
    });

    const spy = vi.spyOn(queueModule, 'getProviderQueue').mockImplementation((name: string) => {
      return { name, getWaiting: getWaiting.bind({ name }) } as unknown as ReturnType<
        typeof queueModule.getProviderQueue
      >;
    });

    try {
      const snapshotPromise = buildQueueSnapshot();
      // Both providers' getWaiting calls should be issued before either resolves.
      await new Promise((r) => setTimeout(r, 10));
      expect(callOrder).toEqual(expect.arrayContaining(['test-provider', PROVIDER_TWO_NAME]));
      release['test-provider']?.([]);
      release[PROVIDER_TWO_NAME]?.([]);
      const snapshot = await snapshotPromise;
      expect(snapshot.waiting).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
