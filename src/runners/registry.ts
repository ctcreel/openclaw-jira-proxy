import type { AgentRunner } from './types';

const runners: Record<string, AgentRunner> = {};

export function registerRunner(runner: AgentRunner): void {
  runners[runner.name] = runner;
}

export function getRunner(name: string): AgentRunner {
  const runner = runners[name];
  if (!runner) {
    throw new Error(
      `Unknown runner: ${name}. Registered runners: ${Object.keys(runners).join(', ')}`,
    );
  }
  return runner;
}

export function getRegisteredRunners(): readonly AgentRunner[] {
  return Object.values(runners);
}

export function resetRunners(): void {
  for (const key of Object.keys(runners)) {
    delete runners[key];
  }
}
