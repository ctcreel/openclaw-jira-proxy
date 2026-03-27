import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface LoggingContext {
  correlationId: string;
  extra: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<LoggingContext>();

export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? '';
}

export function setCorrelationId(value: string): void {
  const store = storage.getStore();
  if (store) {
    store.correlationId = value;
  }
}

export function generateCorrelationId(): string {
  const newId = randomUUID();
  setCorrelationId(newId);
  return newId;
}

export function getExtraContext(): Record<string, unknown> {
  return { ...(storage.getStore()?.extra ?? {}) };
}

export function setExtraContext(context: Record<string, unknown>): void {
  const store = storage.getStore();
  if (store) {
    Object.assign(store.extra, context);
  }
}

export function clearContext(): void {
  const store = storage.getStore();
  if (store) {
    store.correlationId = '';
    store.extra = {};
  }
}

export function runWithContext<T>(callback: () => T): T {
  return storage.run({ correlationId: '', extra: {} }, callback);
}

export function runWithContextAsync<T>(callback: () => Promise<T>): Promise<T> {
  return storage.run({ correlationId: '', extra: {} }, callback);
}
