/**
 * Transport — Strategy interface for inbound event sources.
 *
 * Each ProviderConfig produces exactly one Transport. The webhook variant
 * registers an HTTP route; the slack-socket variant opens an outbound
 * websocket to Slack. Both feed the same downstream pipeline (routing →
 * dedup → BullMQ enqueue → worker), so callers below the transport layer
 * stay transport-agnostic.
 */
export interface Transport {
  readonly name: string;
  /** Begin accepting events. Idempotent within a single process lifetime. */
  start(): Promise<void>;
  /** Tear down cleanly (sockets closed, listeners removed). Called on SIGTERM/SIGINT. */
  stop(): Promise<void>;
}
