import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { providerSchema, resetSettings } from '../../../src/config';
import type { SlackSocketProviderConfig } from '../../../src/config';
import { EventBus } from '../../../src/services/event-bus.service';
import type { ClawndomEvent } from '../../../src/types/clawndom-event';

const ingestSpy = vi.hoisted(() =>
  vi.fn<[unknown], Promise<{ readonly outcome: 'enqueued'; readonly jobTraceId: string }>>(),
);

vi.mock('../../../src/services/event-ingest.service', () => ({
  ingestEvent: (req: unknown): Promise<{ readonly outcome: 'enqueued'; readonly jobTraceId: string }> =>
    ingestSpy(req),
}));

import {
  SlackSocketTransport,
  type SocketModeClientFactory,
} from '../../../src/strategies/transport/slack-socket.transport';

type Handler = (...args: unknown[]) => void;

class FakeSocketModeClient {
  startMock = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
  disconnectMock = vi.fn<[], Promise<void>>().mockResolvedValue(undefined);
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

  start(): Promise<void> {
    return this.startMock();
  }

  disconnect(): Promise<void> {
    return this.disconnectMock();
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) handler(...args);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const baseProvider: SlackSocketProviderConfig = {
  name: 'slack-bot',
  transport: 'slack-socket',
  appTokenSecret: 'slack_app_token',
  botTokenSecret: 'slack_bot_token',
};

function captureEvents(bus: EventBus): ClawndomEvent[] {
  const captured: ClawndomEvent[] = [];
  bus.subscribe((e) => captured.push(e));
  return captured;
}

function buildTransport(
  overrides: Partial<{
    provider: SlackSocketProviderConfig;
    appToken: string;
    events: EventBus;
  }> = {},
): {
  transport: SlackSocketTransport;
  fakeClient: FakeSocketModeClient;
  factory: SocketModeClientFactory;
  events: EventBus;
} {
  const fakeClient = new FakeSocketModeClient();
  const factory = vi.fn(() => fakeClient) as unknown as SocketModeClientFactory;
  const events = overrides.events ?? new EventBus();
  const transport = new SlackSocketTransport({
    provider: overrides.provider ?? baseProvider,
    appToken: overrides.appToken ?? 'xapp-test-token',
    agents: [],
    events,
    clientFactory: factory,
  });
  return { transport, fakeClient, factory, events };
}

describe('SlackSocketTransport', () => {
  beforeEach(() => {
    resetSettings();
    ingestSpy.mockReset();
    ingestSpy.mockResolvedValue({ outcome: 'enqueued', jobTraceId: 'job-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() builds the client with the app token and attaches handlers', async () => {
    const { transport, fakeClient, factory } = buildTransport();

    await transport.start();

    expect(factory).toHaveBeenCalledWith('xapp-test-token');
    expect(fakeClient.startMock).toHaveBeenCalledOnce();
    expect(fakeClient.listenerCount('slack_event')).toBe(1);
    expect(fakeClient.listenerCount('connected')).toBe(1);
    expect(fakeClient.listenerCount('disconnected')).toBe(1);
    expect(fakeClient.listenerCount('reconnecting')).toBe(1);
    expect(fakeClient.listenerCount('error')).toBe(1);
  });

  it('publishes socket.connected when the client emits "connected"', async () => {
    const { transport, fakeClient, events } = buildTransport();
    const captured = captureEvents(events);

    await transport.start();
    fakeClient.emit('connected');

    const connected = captured.find((e) => e.type === 'socket.connected');
    expect(connected).toBeDefined();
    expect(connected).toMatchObject({
      type: 'socket.connected',
      provider: 'slack-bot',
      traceId: 'slack-bot',
    });
  });

  it('publishes socket.disconnected with reason from the client', async () => {
    const { transport, fakeClient, events } = buildTransport();
    const captured = captureEvents(events);

    await transport.start();
    fakeClient.emit('disconnected', 'pong-timeout');

    const disconnected = captured.find((e) => e.type === 'socket.disconnected');
    expect(disconnected).toMatchObject({
      type: 'socket.disconnected',
      provider: 'slack-bot',
      reason: 'pong-timeout',
    });
  });

  it('publishes socket.disconnected with reason "unknown" when no reason given', async () => {
    const { transport, fakeClient, events } = buildTransport();
    const captured = captureEvents(events);

    await transport.start();
    fakeClient.emit('disconnected');

    const disconnected = captured.find((e) => e.type === 'socket.disconnected');
    expect(disconnected).toMatchObject({ reason: 'unknown' });
  });

  it('publishes socket.reconnecting with an incrementing attempt counter', async () => {
    const { transport, fakeClient, events } = buildTransport();
    const captured = captureEvents(events);

    await transport.start();
    fakeClient.emit('reconnecting');
    fakeClient.emit('reconnecting');

    const reconnects = captured.filter((e) => e.type === 'socket.reconnecting');
    expect(reconnects).toHaveLength(2);
    expect(reconnects[0]).toMatchObject({ attempt: 1 });
    expect(reconnects[1]).toMatchObject({ attempt: 2 });
  });

  it('resets the reconnect counter once the socket reconnects', async () => {
    const { transport, fakeClient, events } = buildTransport();
    const captured = captureEvents(events);

    await transport.start();
    fakeClient.emit('reconnecting');
    fakeClient.emit('reconnecting');
    fakeClient.emit('connected');
    fakeClient.emit('reconnecting');

    const reconnects = captured.filter((e) => e.type === 'socket.reconnecting');
    expect(reconnects.map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2, 1]);
  });

  it('enqueues events_api envelopes before acknowledging (Transport Durability)', async () => {
    const callOrder: string[] = [];
    const ack = vi.fn(async () => {
      callOrder.push('ack');
    });
    ingestSpy.mockImplementation(async () => {
      callOrder.push('ingest');
      return { outcome: 'enqueued', jobTraceId: 'job-1' };
    });

    const { transport, fakeClient } = buildTransport();

    await transport.start();
    fakeClient.emit('slack_event', {
      ack,
      type: 'events_api',
      envelope_id: 'env-1',
      body: { event: { type: 'message', ts: '1.1', channel: 'C1' } },
    });

    await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());

    // Per webhook-proxy-domain "Transport Durability" spec: enqueue first,
    // ack second. The reverse ordering is explicitly forbidden by the
    // "Ack Before Enqueue Rejected" scenario because Slack does not
    // redeliver after a successful ack — ack-then-enqueue would create an
    // at-most-once gap if the process crashed between the two operations.
    expect(callOrder).toEqual(['ingest', 'ack']);
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: baseProvider,
        agents: [],
        parsedPayload: { event: { type: 'message', ts: '1.1', channel: 'C1' } },
        rawBodyString: JSON.stringify({ event: { type: 'message', ts: '1.1', channel: 'C1' } }),
      }),
    );
  });

  it('does NOT ack when ingestEvent rejects, so Slack redelivers', async () => {
    const ack = vi.fn(async () => {});
    ingestSpy.mockRejectedValue(new Error('redis unavailable'));

    const { transport, fakeClient } = buildTransport();

    await transport.start();
    fakeClient.emit('slack_event', {
      ack,
      type: 'events_api',
      envelope_id: 'env-fail',
      body: { event: { type: 'message', ts: '3.3', channel: 'C3' } },
    });

    // Wait for the ingestEvent rejection to propagate through dispatchSlackEvent.
    await vi.waitFor(() => expect(ingestSpy).toHaveBeenCalledOnce());

    // The handler must NOT crash, and ack MUST NOT be called — Slack
    // will redeliver after its 3s timeout, which is the entire point
    // of the durability requirement.
    expect(ack).not.toHaveBeenCalled();
  });

  it('unwraps a Socket Mode payload envelope before passing to ingestEvent', async () => {
    const ack = vi.fn(async () => {});
    const envelopePayload = {
      token: 'xoxb',
      team_id: 'T1',
      event: { type: 'app_mention', ts: '2.2', channel: 'C2' },
    };

    const { transport, fakeClient } = buildTransport();

    await transport.start();
    fakeClient.emit('slack_event', {
      ack,
      type: 'events_api',
      envelope_id: 'env-2',
      body: { envelope_id: 'env-2', type: 'events_api', payload: envelopePayload },
    });

    await vi.waitFor(() => expect(ingestSpy).toHaveBeenCalledOnce());
    expect(ingestSpy).toHaveBeenCalledWith(
      expect.objectContaining({ parsedPayload: envelopePayload }),
    );
  });

  it('acks but does not ingest non-events_api envelopes', async () => {
    const ack = vi.fn(async () => {});
    const { transport, fakeClient } = buildTransport();

    await transport.start();
    fakeClient.emit('slack_event', {
      ack,
      type: 'slash_commands',
      envelope_id: 'env-3',
      body: {},
    });

    // Give the microtask queue a tick to run the ack.
    await Promise.resolve();
    await Promise.resolve();
    expect(ack).toHaveBeenCalledOnce();
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('emits socket.auth_failed and retries 60s later when start() rejects', async () => {
    vi.useFakeTimers();
    const { transport, fakeClient, events } = buildTransport();
    const captured = captureEvents(events);
    fakeClient.startMock
      .mockRejectedValueOnce(new Error('invalid_auth'))
      .mockResolvedValueOnce(undefined);

    await transport.start();

    const authFailed = captured.find((e) => e.type === 'socket.auth_failed');
    expect(authFailed).toMatchObject({
      type: 'socket.auth_failed',
      provider: 'slack-bot',
      reason: 'invalid_auth',
    });
    expect(fakeClient.startMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakeClient.startMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry once stop() has been called', async () => {
    vi.useFakeTimers();
    const { transport, fakeClient } = buildTransport();
    fakeClient.startMock.mockRejectedValue(new Error('invalid_auth'));

    await transport.start();
    await transport.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakeClient.startMock).toHaveBeenCalledOnce();
  });

  it('stop() disconnects the client and detaches handlers', async () => {
    const { transport, fakeClient } = buildTransport();
    await transport.start();

    expect(fakeClient.listenerCount('slack_event')).toBe(1);

    await transport.stop();

    expect(fakeClient.disconnectMock).toHaveBeenCalledOnce();
    expect(fakeClient.listenerCount('slack_event')).toBe(0);
    expect(fakeClient.listenerCount('connected')).toBe(0);
    expect(fakeClient.listenerCount('disconnected')).toBe(0);
    expect(fakeClient.listenerCount('reconnecting')).toBe(0);
    expect(fakeClient.listenerCount('error')).toBe(0);
  });

  it('stop() swallows disconnect errors during shutdown', async () => {
    const { transport, fakeClient } = buildTransport();
    fakeClient.disconnectMock.mockRejectedValue(new Error('socket already closed'));
    await transport.start();

    await expect(transport.stop()).resolves.toBeUndefined();
  });

  it('continues with ingest if ack throws on an events_api envelope', async () => {
    const ack = vi.fn(async () => {
      throw new Error('ack-failed');
    });

    const { transport, fakeClient } = buildTransport();

    await transport.start();
    fakeClient.emit('slack_event', {
      ack,
      type: 'events_api',
      envelope_id: 'env-4',
      body: { event: { type: 'message' } },
    });

    await vi.waitFor(() => expect(ingestSpy).toHaveBeenCalledOnce());
  });

  it('does not throw out of the socket handler when ingestEvent rejects', async () => {
    ingestSpy.mockRejectedValueOnce(new Error('redis-down'));
    const { transport, fakeClient } = buildTransport();

    await transport.start();
    expect(() =>
      fakeClient.emit('slack_event', {
        ack: vi.fn(async () => {}),
        type: 'events_api',
        envelope_id: 'env-5',
        body: { event: { type: 'message' } },
      }),
    ).not.toThrow();

    await vi.waitFor(() => expect(ingestSpy).toHaveBeenCalledOnce());
  });

  describe('channelMap enrichment', () => {
    const providerWithChannelMap: SlackSocketProviderConfig = {
      ...baseProvider,
      channelMap: { ops: 'C123', alerts: 'C456' },
    };

    /** Start a transport, emit a slack_event, wait for ingest, return the ingested call. */
    async function emitAndCapture(
      opts: { provider?: SlackSocketProviderConfig; channel: string; envelopeId: string; body?: unknown },
    ): Promise<{ parsedPayload: { event: Record<string, unknown> }; rawBodyString: string }> {
      const ack = vi.fn(async () => {});
      const { transport, fakeClient } = buildTransport({ provider: opts.provider });
      await transport.start();
      fakeClient.emit('slack_event', {
        ack,
        type: 'events_api',
        envelope_id: opts.envelopeId,
        body: opts.body ?? { event: { type: 'message', ts: '1.1', channel: opts.channel } },
      });
      await vi.waitFor(() => expect(ingestSpy).toHaveBeenCalledOnce());
      return ingestSpy.mock.calls[0]?.[0] as {
        parsedPayload: { event: Record<string, unknown> };
        rawBodyString: string;
      };
    }

    it('injects event.channel_name when an inbound channel id matches the map', async () => {
      const call = await emitAndCapture({
        provider: providerWithChannelMap, channel: 'C123', envelopeId: 'env-cm-1',
      });
      expect(call.parsedPayload.event.channel_name).toBe('ops');
      expect(call.parsedPayload.event.channel).toBe('C123');
      expect(JSON.parse(call.rawBodyString).event.channel_name).toBe('ops');
    });

    it('leaves event.channel_name unset when the inbound channel id has no mapping', async () => {
      const call = await emitAndCapture({
        provider: providerWithChannelMap, channel: 'C999', envelopeId: 'env-cm-2',
      });
      expect(call.parsedPayload.event.channel).toBe('C999');
      expect(call.parsedPayload.event).not.toHaveProperty('channel_name');
    });

    it('leaves payload unchanged when provider has no channelMap', async () => {
      const call = await emitAndCapture({ channel: 'C123', envelopeId: 'env-cm-3' });
      expect(call.parsedPayload.event).not.toHaveProperty('channel_name');
    });

    it('enriches payloads after the Socket Mode envelope is unwrapped', async () => {
      const inner = {
        token: 'xoxb',
        team_id: 'T1',
        event: { type: 'app_mention', ts: '2.2', channel: 'C456' },
      };
      const call = await emitAndCapture({
        provider: providerWithChannelMap,
        channel: 'C456',
        envelopeId: 'env-cm-4',
        body: { envelope_id: 'env-cm-4', type: 'events_api', payload: inner },
      });
      expect(call.parsedPayload.event.channel_name).toBe('alerts');
      expect(call.parsedPayload.event.channel).toBe('C456');
    });
  });

  it('logs error events from the client without throwing', async () => {
    const { transport, fakeClient } = buildTransport();
    await transport.start();

    expect(() => fakeClient.emit('error', new Error('socket error'))).not.toThrow();
    expect(() => fakeClient.emit('error', 'string error')).not.toThrow();
  });
});

describe('slackSocketProviderSchema channelMap', () => {
  const baseProviderInput = {
    name: 'slack-bot',
    transport: 'slack-socket' as const,
    appTokenSecret: 'slack_app_token',
    botTokenSecret: 'slack_bot_token',
  };

  it('accepts a channelMap with valid Slack channel and DM IDs', () => {
    const result = providerSchema.safeParse({
      ...baseProviderInput,
      channelMap: { ops: 'C08V6MV0VNV', winston: 'D07ABCDE123' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an absent channelMap (backward compat)', () => {
    const result = providerSchema.safeParse(baseProviderInput);
    expect(result.success).toBe(true);
  });

  it('rejects a channelMap whose value is not a Slack channel/DM ID', () => {
    const result = providerSchema.safeParse({
      ...baseProviderInput,
      channelMap: { ops: 'not-a-channel-id' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a channelMap whose value uses a lowercase prefix', () => {
    const result = providerSchema.safeParse({
      ...baseProviderInput,
      channelMap: { ops: 'c08v6mv0vnv' },
    });
    expect(result.success).toBe(false);
  });
});
