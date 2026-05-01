import { slackSessionKeyStrategy } from './slack';
import type { SessionKeyStrategy } from './types';

export type { SessionKeyStrategy, SessionConfig } from './types';
export { sessionConfigSchema } from './types';

const registry: Map<string, SessionKeyStrategy> = new Map([
  [slackSessionKeyStrategy.name, slackSessionKeyStrategy],
]);

/**
 * Resolve a `SessionKeyStrategy` by name. Returns `undefined` for unknown
 * names; callers (the routing-config validator at startup, and the worker
 * at dispatch time) MUST decide how to surface that.
 */
export function getSessionKeyStrategy(name: string): SessionKeyStrategy | undefined {
  return registry.get(name);
}

/**
 * Test-only: register a custom strategy. Used by tests for fixtures that
 * shouldn't ship to production. Returns a teardown function that restores
 * the registry.
 */
export function registerSessionKeyStrategyForTest(strategy: SessionKeyStrategy): () => void {
  const previous = registry.get(strategy.name);
  registry.set(strategy.name, strategy);
  return () => {
    if (previous === undefined) {
      registry.delete(strategy.name);
    } else {
      registry.set(strategy.name, previous);
    }
  };
}

/** All registered strategy names. Used at config-load to validate `session.strategy`. */
export function listSessionKeyStrategies(): readonly string[] {
  return Array.from(registry.keys());
}
