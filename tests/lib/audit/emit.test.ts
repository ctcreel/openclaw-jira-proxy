import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeAuditRecord, getAuditLogPath } from '../../../src/lib/audit/emit';
import type { AuditRecord } from '../../../src/lib/audit/types';

describe('writeAuditRecord', () => {
  let workDir: string;
  let auditPath: string;
  let originalAuditEnv: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'spe-2078-audit-'));
    auditPath = join(workDir, 'subdir', 'audit.log');
    originalAuditEnv = process.env['CLAWNDOM_AUDIT_LOG'];
    process.env['CLAWNDOM_AUDIT_LOG'] = auditPath;
  });

  afterEach(async () => {
    if (originalAuditEnv === undefined) {
      delete process.env['CLAWNDOM_AUDIT_LOG'];
    } else {
      process.env['CLAWNDOM_AUDIT_LOG'] = originalAuditEnv;
    }
    await rm(workDir, { recursive: true, force: true });
  });

  function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
    return {
      timestamp: '2026-05-11T17:00:00Z',
      agent_id: 'winston',
      route_id: 'slack-winston',
      tool_name: 'slack_post',
      args: { channel: 'C123', text: 'hello' },
      result_summary: { ok: true },
      error_summary: null,
      latency_ms: 123,
      request_id: 'req-abc',
      correlation_id: 'req-abc',
      agent_version: 'sha256:test',
      ...overrides,
    };
  }

  it('writes one NDJSON line per record', async () => {
    await writeAuditRecord(makeRecord({ tool_name: 'tool_a' }));
    await writeAuditRecord(makeRecord({ tool_name: 'tool_b' }));

    const contents = await readFile(auditPath, 'utf-8');
    const lines = contents.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? '') as AuditRecord;
    const second = JSON.parse(lines[1] ?? '') as AuditRecord;
    expect(first.tool_name).toBe('tool_a');
    expect(second.tool_name).toBe('tool_b');
  });

  it('creates the parent directory if it does not exist', async () => {
    await writeAuditRecord(makeRecord());
    const contents = await readFile(auditPath, 'utf-8');
    expect(contents).toContain('"tool_name":"slack_post"');
  });

  it('preserves all required fields in the serialized record', async () => {
    await writeAuditRecord(makeRecord());
    const contents = await readFile(auditPath, 'utf-8');
    const record = JSON.parse(contents.trim()) as AuditRecord;
    expect(record.timestamp).toBe('2026-05-11T17:00:00Z');
    expect(record.agent_id).toBe('winston');
    expect(record.route_id).toBe('slack-winston');
    expect(record.correlation_id).toBe('req-abc');
    expect(record.agent_version).toBe('sha256:test');
  });
});

describe('getAuditLogPath', () => {
  it('uses the env override when set', () => {
    const previous = process.env['CLAWNDOM_AUDIT_LOG'];
    process.env['CLAWNDOM_AUDIT_LOG'] = '/tmp/custom/audit.log';
    try {
      expect(getAuditLogPath()).toBe('/tmp/custom/audit.log');
    } finally {
      if (previous === undefined) {
        delete process.env['CLAWNDOM_AUDIT_LOG'];
      } else {
        process.env['CLAWNDOM_AUDIT_LOG'] = previous;
      }
    }
  });
});
