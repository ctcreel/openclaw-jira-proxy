import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AuditRecord } from './types';

/**
 * Write a single audit record as one NDJSON line to the configured audit log
 * file. Every `tool_use` dispatch MUST flow through this function — the
 * single-function seam SPE-2079 will swap for the unified logging framework.
 *
 * Default path: `/var/log/clawndom-winston/audit.log`. Override via
 * `CLAWNDOM_AUDIT_LOG` environment variable.
 *
 * See `openspec/changes/spe-2078-tool-use/specs/observability/spec.md`,
 * Requirement: Per-Tool-Invocation Audit Stream.
 */

const DEFAULT_AUDIT_LOG_PATH = '/var/log/clawndom-winston/audit.log';

export function getAuditLogPath(): string {
  return process.env['CLAWNDOM_AUDIT_LOG'] ?? DEFAULT_AUDIT_LOG_PATH;
}

export async function writeAuditRecord(record: AuditRecord): Promise<void> {
  const path = getAuditLogPath();
  await createParentDir(path);
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(path, line, 'utf-8');
}

async function createParentDir(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
}
