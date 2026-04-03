import { GatewayClient as SdkGatewayClient } from 'openclaw/plugin-sdk/gateway-runtime';
import { generateKeyPairSync, createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLogger } from '../lib/logging';

const logger = getLogger('gateway-client');

const CLAWNDOM_IDENTITY_PATH = join(
  process.env.HOME || '/tmp',
  '.openclaw',
  'identity',
  'clawndom-device-auth.json',
);

function loadClawndomDeviceIdentity(): {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
} {
  if (existsSync(CLAWNDOM_IDENTITY_PATH)) {
    return JSON.parse(readFileSync(CLAWNDOM_IDENTITY_PATH, 'utf8'));
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  // Must match gateway's fingerprintPublicKey: SHA256 of raw 32-byte Ed25519 public key
  const spki = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  const raw =
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
      ? spki.subarray(ED25519_SPKI_PREFIX.length)
      : spki;
  const deviceId = createHash('sha256').update(raw).digest('hex');
  const identity = { deviceId, publicKeyPem, privateKeyPem };
  mkdirSync(dirname(CLAWNDOM_IDENTITY_PATH), { recursive: true });
  writeFileSync(CLAWNDOM_IDENTITY_PATH, JSON.stringify(identity, null, 2));
  logger.info({ deviceId: deviceId.slice(0, 16) }, 'Created new Clawndom device identity');
  return identity;
}

export interface AgentRunResult {
  runId: string;
  status: 'ok' | 'error' | 'timeout';
  startedAt?: string;
  endedAt?: string;
  error?: string;
}

/**
 * Persistent WebSocket client to the OpenClaw gateway.
 * Wraps the official SDK GatewayClient which handles device identity,
 * scope negotiation, reconnection, and the full connect handshake.
 */
export class GatewayClient {
  private client: SdkGatewayClient;
  private started = false;
  private connected = false;
  private connectedPromise: Promise<void> | null = null;
  private resolveConnected: (() => void) | null = null;

  constructor(url: string, token: string) {
    this.client = new SdkGatewayClient({
      url,
      token,
      clientName: 'gateway-client',
      clientDisplayName: 'clawndom',
      clientVersion: '0.2.0',
      platform: 'node',
      mode: 'backend',
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      // Use a separate identity file so Clawndom doesn't collide with the CLI
      deviceIdentity: loadClawndomDeviceIdentity(),
      onEvent: (): void => {}, // ignore events (tick, presence)
      onHelloOk: (): void => {
        logger.info('Gateway WS connected');
        this.connected = true;
        if (this.resolveConnected) {
          this.resolveConnected();
          this.resolveConnected = null;
          this.connectedPromise = null;
        }
      },
      onConnectError: (err: Error): void => {
        logger.error({ error: err.message }, 'Gateway WS connect error');
      },
      onClose: (_code: number, reason: string): void => {
        this.connected = false;
        logger.warn({ reason }, 'Gateway WS disconnected');
      },
    });
  }

  async connect(): Promise<void> {
    if (!this.started) {
      this.client.start();
      this.started = true;
    }
    await this.waitForReady();
  }

  /**
   * Wait until the gateway WS is connected and ready.
   * If already connected, resolves immediately.
   * Polls with backoff up to 30s total before throwing.
   */
  async waitForReady(timeoutMs = 30_000): Promise<void> {
    if (this.connected) return;

    // Reuse existing promise if someone else is already waiting
    if (this.connectedPromise) {
      await this.connectedPromise;
      return;
    }

    this.connectedPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnected = resolve;
      setTimeout(() => {
        if (!this.connected) {
          this.resolveConnected = null;
          this.connectedPromise = null;
          reject(new Error(`Gateway WS not ready after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });

    await this.connectedPromise;
  }

  /**
   * Send a message to an agent and wait for the run to complete.
   * Returns when the agent run finishes (lifecycle end/error).
   */
  async runAndWait(
    params: {
      message: string;
      sessionKey?: string;
      agentId?: string;
      name?: string;
      model?: string;
      thinking?: string;
      deliver?: boolean;
      channel?: string;
      to?: string;
    },
    waitTimeoutMs: number,
  ): Promise<AgentRunResult> {
    // Ensure gateway WS is open — blocks if reconnecting after a disconnect
    await this.waitForReady();

    // Step 1: trigger the run via `agent` RPC
    const agentResult = await this.client.request<{ runId: string; acceptedAt: string }>('agent', {
      ...params,
      idempotencyKey: `clawndom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    const { runId } = agentResult;
    logger.info({ runId }, 'Agent run started');

    // Step 2: wait for completion via `agent.wait` RPC
    const waitResult = await this.client.request<AgentRunResult>(
      'agent.wait',
      {
        runId,
        timeoutMs: waitTimeoutMs,
      },
      { timeoutMs: waitTimeoutMs + 10_000 },
    );

    logger.info({ runId, status: waitResult.status }, 'Agent run completed');

    return { ...waitResult, runId };
  }

  async close(): Promise<void> {
    this.client.stop();
    this.started = false;
  }
}
