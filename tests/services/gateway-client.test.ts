import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SDK — this wrapper is thin, so tests only assert the contract
// it exposes (start/stop, hello-ok promise wiring, agent + agent.wait RPC
// chaining). Protocol-level behavior is the SDK's responsibility and is
// tested in its own repo.
type OnHelloOk = () => void;

interface MockClientConfig {
  onHelloOk?: OnHelloOk;
}

type ClientInstance = {
  start: () => void;
  stop: () => void;
  request: ReturnType<typeof vi.fn>;
  config: MockClientConfig;
  triggerHelloOk: () => void;
};

const clients: ClientInstance[] = [];

vi.mock('openclaw/plugin-sdk/gateway-runtime', () => ({
  GatewayClient: class {
    private readonly config: MockClientConfig;
    public start = vi.fn();
    public stop = vi.fn();
    public request = vi.fn();
    constructor(config: MockClientConfig) {
      this.config = config;
      clients.push({
        start: this.start,
        stop: this.stop,
        request: this.request,
        config,
        triggerHelloOk: () => config.onHelloOk?.(),
      });
    }
  },
}));

// Mock device-identity file I/O so tests don't touch the real HOME.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() =>
      JSON.stringify({
        deviceId: 'test-device',
        publicKeyPem: 'pub',
        privateKeyPem: 'priv',
      }),
    ),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { GatewayClient } from '../../src/services/gateway-client';

describe('GatewayClient', () => {
  beforeEach(() => {
    clients.length = 0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Best-effort close; stop() is a mock so no-op at the SDK layer
  });

  it('is not connected before connect() is called', () => {
    const client = new GatewayClient('ws://test', 'token');
    expect(client.isConnected()).toBe(false);
  });

  it('connect() starts the SDK client and resolves when hello-ok fires', async () => {
    const client = new GatewayClient('ws://test', 'token');
    const sdk = clients[0];

    const connectPromise = client.connect();
    // Simulate SDK handshake completing
    sdk.triggerHelloOk();
    await connectPromise;

    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(true);
  });

  it('connect() is a no-op when already connected', async () => {
    const client = new GatewayClient('ws://test', 'token');
    const sdk = clients[0];

    const first = client.connect();
    sdk.triggerHelloOk();
    await first;

    await client.connect();
    expect(sdk.start).toHaveBeenCalledTimes(1);
  });

  it('connect() dedups concurrent callers', async () => {
    const client = new GatewayClient('ws://test', 'token');
    const sdk = clients[0];

    const a = client.connect();
    const b = client.connect();
    sdk.triggerHelloOk();
    await Promise.all([a, b]);

    expect(sdk.start).toHaveBeenCalledTimes(1);
  });

  it('waitForReady() rejects when hello-ok does not arrive before timeout', async () => {
    const client = new GatewayClient('ws://test', 'token');
    await expect(client.waitForReady(10)).rejects.toThrow('Gateway WS not ready');
  });

  it('runAndWait() sends agent then agent.wait and returns the result', async () => {
    const client = new GatewayClient('ws://test', 'token');
    const sdk = clients[0];

    sdk.request
      .mockResolvedValueOnce({ runId: 'run-1', acceptedAt: '2026-04-19T00:00:00Z' })
      .mockResolvedValueOnce({ runId: 'run-1', status: 'ok' });

    // Pre-connect so waitForReady short-circuits
    const connectPromise = client.connect();
    sdk.triggerHelloOk();
    await connectPromise;

    const result = await client.runAndWait({ message: 'test', agentId: 'patch' }, 60_000);

    expect(result.runId).toBe('run-1');
    expect(result.status).toBe('ok');
    expect(sdk.request).toHaveBeenNthCalledWith(
      1,
      'agent',
      expect.objectContaining({ message: 'test', agentId: 'patch' }),
    );
    expect(sdk.request).toHaveBeenNthCalledWith(
      2,
      'agent.wait',
      { runId: 'run-1', timeoutMs: 60_000 },
      { timeoutMs: 70_000 },
    );
  });

  it('runAndWait() passes model through to the agent RPC', async () => {
    const client = new GatewayClient('ws://test', 'token');
    const sdk = clients[0];

    sdk.request
      .mockResolvedValueOnce({ runId: 'run-2', acceptedAt: '2026-04-19T00:00:00Z' })
      .mockResolvedValueOnce({ runId: 'run-2', status: 'ok' });

    const connectPromise = client.connect();
    sdk.triggerHelloOk();
    await connectPromise;

    await client.runAndWait(
      { message: 'test', agentId: 'patch', model: 'anthropic/claude-opus-4-7' },
      60_000,
    );

    const firstCallArgs = sdk.request.mock.calls[0];
    expect(firstCallArgs[0]).toBe('agent');
    expect(firstCallArgs[1]).toMatchObject({ model: 'anthropic/claude-opus-4-7' });
  });

  it('runAndWait() propagates agent RPC errors', async () => {
    const client = new GatewayClient('ws://test', 'token');
    const sdk = clients[0];

    sdk.request.mockRejectedValueOnce(new Error('Invalid token'));

    const connectPromise = client.connect();
    sdk.triggerHelloOk();
    await connectPromise;

    await expect(client.runAndWait({ message: 'test' }, 60_000)).rejects.toThrow('Invalid token');
  });

  it('runAndWait() propagates agent.wait errors', async () => {
    const client = new GatewayClient('ws://test', 'token');
    const sdk = clients[0];

    sdk.request
      .mockResolvedValueOnce({ runId: 'run-3', acceptedAt: '2026-04-19T00:00:00Z' })
      .mockRejectedValueOnce(new Error('wait timeout'));

    const connectPromise = client.connect();
    sdk.triggerHelloOk();
    await connectPromise;

    await expect(client.runAndWait({ message: 'test' }, 60_000)).rejects.toThrow('wait timeout');
  });

  it('close() stops the SDK client', async () => {
    const client = new GatewayClient('ws://test', 'token');
    const sdk = clients[0];

    await client.close();
    expect(sdk.stop).toHaveBeenCalledTimes(1);
  });
});
