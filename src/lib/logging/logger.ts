import pino from 'pino';
import type { Logger } from 'pino';

import { getLoggingConfig, type LoggingConfig } from './config';
import { getCorrelationId, getExtraContext } from './context';

let rootLogger: Logger | null = null;
let configured = false;

export function setupLogging(config?: LoggingConfig, options?: { force?: boolean }): void {
  if (configured && !options?.force) {
    return;
  }

  const effectiveConfig = config ?? getLoggingConfig();

  const pinoConfig: pino.LoggerOptions = {
    level: effectiveConfig.logLevel,
    timestamp: effectiveConfig.includeTimestamp,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    mixin: () => {
      const extra: Record<string, unknown> = {};
      const correlationId = getCorrelationId();
      if (correlationId) {
        extra.correlationId = correlationId;
      }
      extra.service = effectiveConfig.serviceName;
      const extraContext = getExtraContext();
      return { ...extra, ...extraContext };
    },
  };

  if (effectiveConfig.logFormat === 'human') {
    pinoConfig.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      },
    };
  }

  rootLogger = pino(pinoConfig);
  configured = true;
}

export function getLogger(name: string): Logger {
  if (rootLogger === null) {
    setupLogging();
  }
  if (rootLogger === null) {
    throw new Error('Failed to initialize logger');
  }
  return rootLogger.child({ logger: name });
}

export function resetLogging(): void {
  configured = false;
  rootLogger = null;
}
