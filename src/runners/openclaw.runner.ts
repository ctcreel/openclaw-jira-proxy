import type { GatewayClient } from '../services/gateway-client';
import { getLogger } from '../lib/logging';
import type { AgentRunner, RunOptions, RunResult } from './types';

const logger = getLogger('runner:openclaw');

/**
 * Wraps the existing GatewayClient WebSocket connection.
 * Delegates to `runAndWait` and maps the result to RunResult.
 */
export class OpenClawRunner implements AgentRunner {
  readonly name = 'openclaw';
  private readonly client: GatewayClient;

  constructor(gatewayClient: GatewayClient) {
    this.client = gatewayClient;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    logger.info('OpenClaw gateway connected');
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  isHealthy(): boolean {
    return this.client.isConnected();
  }

  async run(options: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();

    const result = await this.client.runAndWait(
      {
        message: options.prompt,
        sessionKey: options.sessionKey,
        agentId: options.agentId,
        model: options.model,
        bootstrapContextMode: 'lightweight',
      },
      options.timeoutMs,
    );

    const endedAt = new Date().toISOString();

    return {
      status: result.status,
      runId: result.runId,
      error: result.error,
      startedAt,
      endedAt,
      renderedPrompt: options.prompt,
    };
  }
}
