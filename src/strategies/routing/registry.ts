import type { RoutingStrategy } from './types';

const strategies: Record<string, RoutingStrategy> = {};

export function registerRoutingStrategy(strategy: RoutingStrategy): void {
  strategies[strategy.name] = strategy;
}

export function getRoutingStrategy(name: string): RoutingStrategy {
  const strategy = strategies[name];
  if (!strategy) {
    throw new Error(
      `Unknown routing strategy: ${name}. Valid strategies: ${Object.keys(strategies).join(', ')}`,
    );
  }
  return strategy;
}

export function resetRoutingStrategies(): void {
  for (const key of Object.keys(strategies)) {
    delete strategies[key];
  }
}
