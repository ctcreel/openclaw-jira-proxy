import { randomUUID } from 'node:crypto';

import { SocketModeClient } from '@slack/socket-mode';

import type { SlackSocketProviderConfig } from '../../config';
import type { ResolvedAgent } from '../../services/agent-loader.service';
import { getEventBus } from '../../services/event-bus.service';
import type { EventBus } from '../../services/event-bus.service';
import { ingestEvent } from '../../services/event-ingest.service';
import { getLogger } from '../../lib/logging';

import { mapSocketModeEnvelopeToWebhookPayload } from './event-mapper';
import { buildChannelIdToNameMap, enrichSlackPayload } from './slack-payload';
import type { Transport } from './types';

const logger = getLogger('slack-socket-transport');

/**
 * Slack Socket Mode adapter — outbound websocket alternative to HTTP webhooks.
 *
 * The bot opens an outbound connection to Slack at startup using the
 * configured app-level token (xapp-*). Inbound events flow through the
 * same routing pipeline (routing → dedup → BullMQ enqueue → worker) as
 * the HTTP webhook controller. Aligns with the project's Strategy
 * convention (AgentRunner, SignatureStrategy, ContextStrategy).
 *
 * Lifecycle:
 *  - start(): opens the socket; resolves once connected
 *  - on auth failure: emits socket.auth_failed and retries every 60s
 *  - on socket drop: relies on @slack/socket-mode's autoReconnect; emits socket.reconnecting / socket.connected
 *  - stop(): cancels any pending retry, disconnects cleanly
 *
 * Slack's 3-second ack budget is honored: ack() runs synchronously inside
 * the event handler before ingestEvent is awaited. The agent run itself
 * happens later in the BullMQ worker; Slack has long since seen the 200.
 */
const AUTH_FAILED_RETRY_MS = 60_000;

interface SlackEventListenerArgs {
  ack: () => Promise<void>;
  body: unknown;
  envelope_id?: string;
  type?: string;
}

interface SocketModeClientLike {
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
}

export type SocketModeClientFactory = (appToken: string) => SocketModeClientLike;

const defaultClientFactory: SocketModeClientFactory = (appToken) =>
  new SocketModeClient({ appToken }) as unknown as SocketModeClientLike;

export interface SlackSocketTransportOptions {
  readonly provider: SlackSocketProviderConfig;
  readonly appToken: string;
  readonly agents: readonly ResolvedAgent[];
  readonly events?: EventBus;
  /** Override for tests. Defaults to lazy-importing @slack/socket-mode. */
  readonly clientFactory?: SocketModeClientFactory;
}

export class SlackSocketTransport implements Transport {
  readonly name: string;

  private readonly provider: SlackSocketProviderConfig;
  private readonly appToken: string;
  private readonly agents: readonly ResolvedAgent[];
  private readonly events: EventBus;
  private readonly clientFactory: SocketModeClientFactory;
  private readonly channelIdToName: ReadonlyMap<string, string>;

  private client: SocketModeClientLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private reconnectAttempts = 0;

  private readonly handleSlackEvent: (...args: unknown[]) => void;
  private readonly handleConnected: () => void;
  private readonly handleDisconnected: (...args: unknown[]) => void;
  private readonly handleReconnecting: () => void;
  private readonly handleError: (...args: unknown[]) => void;

  constructor(options: SlackSocketTransportOptions) {
    this.provider = options.provider;
    this.appToken = options.appToken;
    this.agents = options.agents;
    this.events = options.events ?? getEventBus();
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.name = options.provider.name;
    this.channelIdToName = buildChannelIdToNameMap(options.provider.channelMap);

    this.handleSlackEvent = (...args: unknown[]): void => {
      const argument = args[0];
      if (argument && typeof argument === 'object') {
        void this.dispatchSlackEvent(argument as SlackEventListenerArgs);
      }
    };
    this.handleConnected = (): void => {
      this.reconnectAttempts = 0;
      this.events.publish({
        type: 'socket.connected',
        timestamp: Date.now(),
        traceId: this.provider.name,
        provider: this.provider.name,
      });
      logger.info({ provider: this.provider.name }, 'Slack socket connected');
    };
    this.handleDisconnected = (...args: unknown[]): void => {
      const reason = typeof args[0] === 'string' ? args[0] : 'unknown';
      this.events.publish({
        type: 'socket.disconnected',
        timestamp: Date.now(),
        traceId: this.provider.name,
        provider: this.provider.name,
        reason,
      });
      logger.info({ provider: this.provider.name, reason }, 'Slack socket disconnected');
    };
    this.handleReconnecting = (): void => {
      this.reconnectAttempts += 1;
      this.events.publish({
        type: 'socket.reconnecting',
        timestamp: Date.now(),
        traceId: this.provider.name,
        provider: this.provider.name,
        attempt: this.reconnectAttempts,
      });
      logger.info(
        { provider: this.provider.name, attempt: this.reconnectAttempts },
        'Slack socket reconnecting',
      );
    };
    this.handleError = (...args: unknown[]): void => {
      const error = args[0];
      const reason = error instanceof Error ? error.message : String(error);
      logger.error({ provider: this.provider.name, reason }, 'Slack socket error');
    };
  }

  async start(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.client = this.clientFactory(this.appToken);
    this.attachHandlers(this.client);
    await this.startWithAuthRetry();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.client !== null) {
      this.detachHandlers(this.client);
      try {
        await this.client.disconnect();
      } catch (error: unknown) {
        logger.warn(
          {
            provider: this.provider.name,
            reason: error instanceof Error ? error.message : String(error),
          },
          'Slack socket disconnect raised; ignoring (process is shutting down)',
        );
      }
      this.client = null;
    }
  }

  private async startWithAuthRetry(): Promise<void> {
    if (this.client === null || this.stopped) {
      return;
    }
    try {
      await this.client.start();
    } catch (error: unknown) {
      if (this.stopped) {
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.events.publish({
        type: 'socket.auth_failed',
        timestamp: Date.now(),
        traceId: this.provider.name,
        provider: this.provider.name,
        reason,
      });
      logger.error(
        { provider: this.provider.name, reason },
        `Slack socket start failed; retrying in ${AUTH_FAILED_RETRY_MS}ms`,
      );
      this.scheduleAuthRetry();
    }
  }

  private scheduleAuthRetry(): void {
    if (this.stopped) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.startWithAuthRetry();
    }, AUTH_FAILED_RETRY_MS);
  }

  private attachHandlers(client: SocketModeClientLike): void {
    client.on('slack_event', this.handleSlackEvent);
    client.on('connected', this.handleConnected);
    client.on('disconnected', this.handleDisconnected);
    client.on('reconnecting', this.handleReconnecting);
    client.on('error', this.handleError);
  }

  private detachHandlers(client: SocketModeClientLike): void {
    client.off('slack_event', this.handleSlackEvent);
    client.off('connected', this.handleConnected);
    client.off('disconnected', this.handleDisconnected);
    client.off('reconnecting', this.handleReconnecting);
    client.off('error', this.handleError);
  }

  private async dispatchSlackEvent(args: SlackEventListenerArgs): Promise<void> {
    const eventType = typeof args.type === 'string' ? args.type : null;
    // Only `events_api` envelopes drive agent runs. Slash commands and
    // interactive components are out of scope for this ticket.
    if (eventType !== null && eventType !== 'events_api') {
      try {
        await args.ack();
      } catch (error: unknown) {
        logger.warn(
          {
            provider: this.provider.name,
            reason: error instanceof Error ? error.message : String(error),
            envelopeType: eventType,
          },
          'Slack ack failed for non-events_api envelope',
        );
      }
      return;
    }

    // Per webhook-proxy-domain spec "Transport Durability" + "Ack Before
    // Enqueue Rejected" scenario: enqueue MUST complete before ack. The
    // local Redis SETNX + XADD is sub-millisecond and stays well inside
    // Slack's 3s window. If ingestEvent throws, we deliberately do NOT
    // ack — Slack redelivers after timeout, which is the durability
    // guarantee. The reverse ordering would create an at-most-once gap
    // because Slack does not redeliver after a successful ack.
    const traceId = randomUUID();
    const mappedPayload = mapSocketModeEnvelopeToWebhookPayload(args.body);
    const payload = enrichSlackPayload(mappedPayload, this.channelIdToName);
    const rawBodyString = JSON.stringify(payload);

    try {
      await ingestEvent({
        provider: this.provider,
        agents: this.agents,
        rawBodyString,
        parsedPayload: payload,
        traceId,
        events: this.events,
      });
    } catch (error: unknown) {
      // Do NOT ack — let Slack redeliver. Failure is observable via the
      // logger (and any failed-job emits inside ingestEvent itself).
      logger.error(
        {
          provider: this.provider.name,
          reason: error instanceof Error ? error.message : String(error),
        },
        'Slack ingest failed; not acknowledging to allow Slack redelivery',
      );
      return;
    }

    try {
      await args.ack();
    } catch (error: unknown) {
      // Ingest succeeded; ack failure means Slack will redeliver and the
      // existing dedup path will deduplicate the second arrival. Log so
      // the redundant work is observable, but do not unwind the enqueue.
      logger.warn(
        {
          provider: this.provider.name,
          reason: error instanceof Error ? error.message : String(error),
        },
        'Slack ack failed after successful ingest; redelivery will be deduplicated',
      );
    }
  }
}
