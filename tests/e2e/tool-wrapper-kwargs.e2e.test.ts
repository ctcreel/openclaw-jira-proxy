/**
 * E2E smoke test for bug shape #2 — agent-callable tool wrapper kwarg
 * shape.
 *
 * In production, `agency_tools.google.gmail_reply` (and `gmail_forward`)
 * exposed a `subject` kwarg whose contents were actually the DWD
 * impersonation mailbox — the wrapper layer passed `subject=…` to a
 * Python impl that expected `mailbox=…` and only supported `subject`
 * through a compatibility shim. A normal happy-path call from clawndom's
 * executor blew up with `TypeError: invoke() got an unexpected keyword
 * argument 'subject'` (or similar shadow).
 *
 * The bug lived undetected because nothing on either side exercised
 * "call the wrapper with the documented happy-path arg shape, assert no
 * TypeError." This smoke test seals that gap on the clawndom side by
 * driving `executeToolCall` through a fixture impl that mirrors the
 * documented signature (`def invoke(*, message_id, body, mailbox, **_)`)
 * and asserts that the dispatch:
 *   1. Completes without raising / without an `error_summary` in audit.
 *   2. Lands a single audit record with `tool_name` and `args` redacted
 *      as expected.
 *
 * The corresponding test on the agency-tools side (which actually owns
 * the wrapper) is the boundary check that catches a kwarg-name drift
 * at its source. See `the-agency/workspaces/shared/agency_tools/google/`
 * for that suite — the test here is the "did the executor end of the
 * contract continue to honour the same shape" complement.
 *
 * Requires: python3 on PATH (same prerequisite as the existing
 * mcp-bridge-e2e and credential-leakage-probe tests).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeToolCall } from '../../src/services/tools/executor';
import type { ToolDescriptor } from '../../src/services/tools/descriptor';
import {
  initializeAgentVersion,
  resetAgentVersionCacheForTests,
} from '../../src/services/version.service';

interface AuditLine {
  readonly tool_name: string;
  readonly args: Record<string, unknown>;
  readonly result_summary: unknown;
  readonly error_summary: string | null;
  readonly agent_id: string;
  readonly route_id: string;
}

describe('e2e: gmail_reply tool wrapper accepts the documented kwarg shape', () => {
  let workDir: string;
  let auditPath: string;
  let originalAuditLog: string | undefined;
  let originalPythonPath: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'clawndom-e2e-gmail-reply-'));
    auditPath = join(workDir, 'audit.log');
    originalAuditLog = process.env['CLAWNDOM_AUDIT_LOG'];
    process.env['CLAWNDOM_AUDIT_LOG'] = auditPath;

    // Stage a fixture Python package whose `invoke()` mirrors the
    // documented happy-path signature of `agency_tools.google.gmail_reply`.
    // The wrapper layer's contract is exactly this kwarg list — anything
    // else (including a stray `subject` shadow) is a contract break.
    const pkgDir = join(workDir, 'fixture_gmail_reply_pkg');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, '__init__.py'), '');
    const implPy =
      'def invoke(*, message_id, body, mailbox, **_):\n' +
      '    return {"sent": True, "to_message": message_id, "from_mailbox": mailbox, "body_length": len(body)}\n';
    await writeFile(join(pkgDir, 'impl.py'), implPy);

    originalPythonPath = process.env['PYTHONPATH'];
    process.env['PYTHONPATH'] = `${workDir}:${originalPythonPath ?? ''}`;

    // The executor embeds `getAgentVersion().hash` in every audit
    // record; it throws if the cache hasn't been primed by boot. Tests
    // that drive the executor directly have to seed it themselves —
    // the clawndom repo root is fine for this since the version is
    // only stamped into the audit record, not compared anywhere.
    await initializeAgentVersion([process.cwd()], process.cwd());
  });

  afterEach(async () => {
    if (originalAuditLog === undefined) delete process.env['CLAWNDOM_AUDIT_LOG'];
    else process.env['CLAWNDOM_AUDIT_LOG'] = originalAuditLog;
    if (originalPythonPath === undefined) delete process.env['PYTHONPATH'];
    else process.env['PYTHONPATH'] = originalPythonPath;
    resetAgentVersionCacheForTests();
    await rm(workDir, { recursive: true, force: true });
  });

  it('accepts message_id/body/mailbox without TypeError and writes a clean audit record', async () => {
    const descriptor: ToolDescriptor = {
      directory: join(workDir, 'fixture_gmail_reply_pkg'),
      reference: 'fixture_gmail_reply_pkg',
      name: 'gmail_reply',
      description: 'Reply to a Gmail thread via DWD-impersonated send.',
      args: {
        message_id: { type: 'string', description: 'In-Reply-To message id.' },
        body: { type: 'string', description: 'Reply body.' },
        mailbox: { type: 'string', description: 'DWD impersonation target.' },
      },
      // No secrets — the fixture impl doesn't require any. The bug surface
      // is the kwarg-shape contract, not the credential plumbing.
      secrets: [],
    };

    const result = await executeToolCall(
      {
        name: 'gmail_reply',
        input: {
          message_id: '<abc123@mail.example.com>',
          body: 'Thanks, will review tomorrow.',
          mailbox: 'heather@example.com',
        },
      },
      descriptor,
      {},
      {
        agentId: 'winston-e2e',
        routeId: 'gmail-pubsub:triage',
        requestId: 'req-gmail-reply-1',
      },
    );

    // The bug surface: a kwarg-shadow regression would manifest as
    // `isError: true` with a TypeError-flavoured `error_summary`. Both
    // assertions below would fail in that case.
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({
      sent: true,
      to_message: '<abc123@mail.example.com>',
      from_mailbox: 'heather@example.com',
    });

    const auditContents = await readFile(auditPath, 'utf-8');
    const records = auditContents
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditLine);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record!.tool_name).toBe('gmail_reply');
    expect(record!.error_summary).toBeNull();
    expect(record!.args).toEqual({
      message_id: '<abc123@mail.example.com>',
      body: 'Thanks, will review tomorrow.',
      mailbox: 'heather@example.com',
    });
  }, 15_000);
});
