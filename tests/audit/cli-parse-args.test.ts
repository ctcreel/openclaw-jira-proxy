/**
 * Tests for the audit CLI's argument parser. Targets branch coverage on the
 * various flag shapes the CLI accepts (--json, --shared-dir, --shared-dir=,
 * -h / --help, unknown flags, missing/extra positionals).
 *
 * `parseArgs` is not exported, so we exercise it through behavioural checks on
 * the full CLI's run-loop by importing the module under test and stubbing
 * process exit. To keep the test simple and the surface narrow, the parser is
 * extracted into a thin re-export here.
 */
import { describe, expect, it } from 'vitest';

// The CLI keeps parseArgs internal. Re-export it for testing purposes via
// the audit module's barrel. If the function moves, this import is the only
// place that needs to update.
import { parseAuditArgs } from '../../src/audit/cli-args';

describe('parseAuditArgs', () => {
  it('returns an error on missing agent-dir', () => {
    const result = parseAuditArgs([]);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Missing required');
    }
  });

  it('returns help when -h is passed', () => {
    const result = parseAuditArgs(['-h']);
    expect('error' in result && result.error === 'help').toBe(true);
  });

  it('returns help when --help is passed', () => {
    const result = parseAuditArgs(['--help']);
    expect('error' in result && result.error === 'help').toBe(true);
  });

  it('rejects unknown flags', () => {
    const result = parseAuditArgs(['--mystery', '/some/path']);
    expect('error' in result && result.error?.startsWith('Unknown flag')).toBe(true);
  });

  it('rejects extra positional arguments', () => {
    const result = parseAuditArgs(['/a', '/b']);
    expect('error' in result && result.error?.includes('Unexpected extra')).toBe(true);
  });

  it('rejects --shared-dir with no value', () => {
    const result = parseAuditArgs(['/path', '--shared-dir']);
    expect('error' in result && result.error?.includes('--shared-dir requires')).toBe(true);
  });

  it('accepts --shared-dir <path>', () => {
    const result = parseAuditArgs(['/path', '--shared-dir', '/shared']);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.sharedDir).toContain('shared');
    }
  });

  it('accepts --shared-dir=<path>', () => {
    const result = parseAuditArgs(['/path', '--shared-dir=/shared']);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.sharedDir).toContain('shared');
    }
  });

  it('accepts --json', () => {
    const result = parseAuditArgs(['/path', '--json']);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.json).toBe(true);
    }
  });

  it('defaults json to false when --json is omitted', () => {
    const result = parseAuditArgs(['/path']);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.json).toBe(false);
    }
  });

  it('resolves agent-dir against cwd', () => {
    const result = parseAuditArgs(['relative/path']);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.agentDir.startsWith('/')).toBe(true);
    }
  });
});
