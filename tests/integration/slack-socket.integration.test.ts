/**
 * Integration: SlackSocketTransport → ingest → BullMQ → worker → runner
 *
 * Fakes the @slack/socket-mode client (no real Slack connection) but uses
 * the real Express config parsing, the real ingest pipeline, the real
 * BullMQ queue, and a capturing runner. Verifies that a `slack_event`
 * envelope fired through the transport reaches `runner.run` with the
 * unwrapped Slack event payload.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Worker as BullMQWorker } from 'bullmq';

import { resetSettings, getSettings } from '../../src/config';
import type { SlackSocketProviderConfig } from '../../src/config';
import { resetQueues } from '../../src/services/queue.service';
import { registerRunner, resetRunners } from '../../src/runners/registry';
import type { AgentRunner, RunOptions, RunResult } from '../../src/runners/types';
import type { ResolvedAgent } from '../../src/services/agent-loader.service';
import {
  SlackSocketTransport,
  type SocketModeClientFactory,
} from '../../src/strategies/transport/slack-socket.transport';

interface DeliveredPayload {
  prompt: string;
  sessionKey: string;
  agentId: string;
  receivedAt: string;
}

const allDeliveries: DeliveredPayload[] = [];

class CapturingRunner implements AgentRunner {
  readonly name = 'openclaw';

  async run(options: RunOptions): Promise<RunResult> {
    allDeliveries.push({
      prompt: options.prompt,
      sessionKey: options.sessionKey,
      agentId: options.agentId,
      receivedAt: new Date().toISOString(),
    });
    return {
      status: 'ok',
      runId: `mock-run-${Date.now()}`,
      renderedPrompt: options.prompt,
    };
  }
}

type Handler = (...args: unknown[]) => void;

class FakeSocketModeClient {
  private readonly listeners = new Map<string, Set<Handler>>();
  on(event: string, handler: Handler): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return this;
  }
  off(event: string, handler: Handler): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }
  async start(): Promise<void> {}
  async disconnect(): Promise<void> {}
  emit(event: string, ...args: unknown[]): void {
    for (const h of [...(this.listeners.get(event) ?? [])]) h(...args);
  }
}

const TEST_AGENTS: ResolvedAgent[] = [
  {
    name: 'patch',
    dir: '/tmp/clawndom-slack-socket-agent',
    config: {
      routing: {
        'slack-bot': { rules: [{ condition: { all_of: [] } }] },
      },
      modelRules: {},
    },
  },
];

const SLACK_SOCKET_PROVIDER = {
  name: 'slack-bot',
  transport: 'slack-socket' as const,
  appTokenSecret: 'slack_app_token',
  botTokenSecret: 'slack_bot_token',
};

let _testCounter = 0;
function nextTestId(): string {
  return `slack-int-${Date.now()}-${++_testCounter}`;
}
let currentTestId = '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deliveriesForCurrentTest(): DeliveredPayload[] {
  return allDeliveries.filter((d) => {
    try {
      const parsed = JSON.parse(d.prompt);
      return parsed._testId === currentTestId;
    } catch {
      return false;
    }
  });
}

async function waitForDeliveries(count: number, timeoutMs = 8000): Promise<DeliveredPayload[]> {
  const start = Date.now();
  let elapsed = Date.now() - start;
  while (elapsed <= timeoutMs) {
    const matched = deliveriesForCurrentTest();
    if (matched.length >= count) return matched;
    await sleep(50);
    elapsed = Date.now() - start;
  }
  const finalMatched = deliveriesForCurrentTest();
  if (finalMatched.length >= count) return finalMatched;
  throw new Error(`Timed out waiting for ${count} deliveries (got ${finalMatched.length})`);
}

describe('Integration: slack-socket transport → BullMQ → runner', () => {
  let workers: Array<BullMQWorker>;
  let transport: SlackSocketTransport;
  let fakeClient: FakeSocketModeClient;

  beforeAll(async () => {
    process.env.BULLMQ_QUEUE_PREFIX = `test-slack-socket-${Date.now()}`;
    process.env.OPENCLAW_TOKEN = 'integration-test-token';
    process.env.OPENCLAW_AGENT_ID = 'patch';
    process.env.PROVIDERS_CONFIG = JSON.stringify([SLACK_SOCKET_PROVIDER]);
    resetSettings();
    resetQueues();
    resetRunners();
    registerRunner(new CapturingRunner());

    const settings = getSettings();
    const provider = settings.providers[0] as SlackSocketProviderConfig;
    expect(provider.transport).toBe('slack-socket');

    const { createWorker } = await import('../../src/services/worker.service');
    workers = settings.providers.map((p) => createWorker({ provider: p, agents: TEST_AGENTS }));

    fakeClient = new FakeSocketModeClient();
    const factory: SocketModeClientFactory = () => fakeClient;
    transport = new SlackSocketTransport({
      provider,
      appToken: 'xapp-test',
      agents: TEST_AGENTS,
      clientFactory: factory,
    });
    await transport.start();
    await sleep(500);
  });

  beforeEach(async () => {
    currentTestId = nextTestId();
    resetRunners();
    registerRunner(new CapturingRunner());

    const IORedis = (await import('ioredis')).default;
    const redisUrl = getSettings().redisUrl;
    const conn = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    const keys = await conn.keys('clawndom:dedup:*');
    if (keys.length > 0) await conn.del(...keys);
    await conn.quit();
  });

  afterAll(async () => {
    await transport.stop();
    if (workers) await Promise.all(workers.map((w) => w.close()));

    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const { buildQueueName } = await import('../../src/services/queue.service');
    const cleanConn = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    const q = new Queue(buildQueueName('slack-bot'), { connection: cleanConn });
    await q.obliterate({ force: true });
    await q.close();
    await cleanConn.quit();

    delete process.env.BULLMQ_QUEUE_PREFIX;
    resetSettings();
    resetQueues();
    resetRunners();
  });

  it(
    'delivers a Slack Socket Mode events_api envelope through to the runner',
    { timeout: 15_000 },
    async () => {
      let acked = false;
      const ack = async (): Promise<void> => {
        acked = true;
      };

      const innerEvent = {
        type: 'message',
        ts: '1730000000.000200',
        channel: 'C08V6MV0VNV',
        blocks: [{ text: { text: 'hello clawndom' } }],
      };
      const httpShapedPayload = {
        token: 'xoxb-fake',
        team_id: 'T1',
        _testId: currentTestId,
        event: innerEvent,
      };

      fakeClient.emit('slack_event', {
        ack,
        type: 'events_api',
        envelope_id: 'env-int-1',
        body: { envelope_id: 'env-int-1', type: 'events_api', payload: httpShapedPayload },
      });

      const deliveries = await waitForDeliveries(1, 8000);
      expect(acked).toBe(true);
      expect(deliveries).toHaveLength(1);

      const forwarded = JSON.parse(deliveries[0]!.prompt);
      expect(forwarded.token).toBe('xoxb-fake');
      expect(forwarded.event.ts).toBe('1730000000.000200');
      expect(forwarded._testId).toBe(currentTestId);
    },
  );
});
