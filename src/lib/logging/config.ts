import { z } from 'zod';

export const LogLevel = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const LogFormat = {
  JSON: 'json',
  HUMAN: 'human',
} as const;

export type LogFormat = (typeof LogFormat)[keyof typeof LogFormat];

const loggingConfigSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  logFormat: z.enum(['json', 'human']).default('json'),
  serviceName: z.string().default('sc0red'),
  includeTimestamp: z.boolean().default(true),
  includeLocation: z.boolean().default(true),
});

export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

let cachedConfig: LoggingConfig | null = null;

export function getLoggingConfig(): LoggingConfig {
  if (cachedConfig !== null) {
    return cachedConfig;
  }
  cachedConfig = loggingConfigSchema.parse({
    logLevel: process.env.LOG_LEVEL?.toLowerCase(),
    logFormat: process.env.LOG_FORMAT?.toLowerCase(),
    serviceName: process.env.SERVICE_NAME,
    includeTimestamp: process.env.INCLUDE_TIMESTAMP !== 'false',
    includeLocation: process.env.INCLUDE_LOCATION !== 'false',
  });
  return cachedConfig;
}

export function resetLoggingConfig(): void {
  cachedConfig = null;
}
