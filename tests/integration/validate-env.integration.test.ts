import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const VALIDATE_SCRIPT = path.resolve(__dirname, '../../infra/ec2/validate-env.sh');

// SPE-2000: validate-env.sh asks systemd to parse an EnvironmentFile= and
// asserts that the four JSON-valued env vars survive the parse as non-empty
// JSON arrays. The whole point is to exercise systemd's real parser rather
// than re-implementing its quoting rules in bash. So the test must run a
// real `systemd-run` call.
//
// Three preconditions:
//   1. We're on Linux.
//   2. `systemd-run` is on PATH.
//   3. We can invoke `sudo -n systemd-run --pipe --wait /usr/bin/true`
//      successfully — i.e. passwordless sudo works AND the system bus is
//      reachable. This holds on the GHA ubuntu-latest runner and on most
//      dev workstations; it does NOT hold inside hardened service
//      sandboxes (NoNewPrivileges, missing /run/dbus). Skip when missing.
//
// We use sudo + the system instance (rather than `--user`) because that's
// what deploy.sh does in production — `sudo bash validate-env.sh ...`. The
// test exercises the production code path.
function probeSystemdRun(): { available: boolean; reason?: string } {
  if (process.platform !== 'linux') {
    return { available: false, reason: `platform=${process.platform}` };
  }
  const which = spawnSync('which', ['systemd-run']);
  if (which.status !== 0) {
    return { available: false, reason: 'systemd-run not on PATH' };
  }
  const probe = spawnSync(
    'sudo',
    ['-n', 'systemd-run', '--quiet', '--pipe', '--wait', '/usr/bin/true'],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) {
    return {
      available: false,
      reason: `sudo -n systemd-run probe failed (status=${probe.status}): ${probe.stderr.trim()}`,
    };
  }
  return { available: true };
}

const probe = probeSystemdRun();
const skipReason = probe.available ? '' : `systemd-run unavailable: ${probe.reason}`;

describe.skipIf(!probe.available)(
  `validate-env.sh — integration (systemd-run round-trip)${skipReason ? ` [skipped: ${skipReason}]` : ''}`,
  () => {
    let workdir: string;

    beforeAll(() => {
      workdir = mkdtempSync(path.join(tmpdir(), 'spe-2000-validate-env-'));
    });

    afterAll(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    function writeEnv(name: string, body: string): string {
      const p = path.join(workdir, name);
      writeFileSync(p, body, { encoding: 'utf8' });
      // systemd-run's transient unit reads the file as root; world-readable
      // is the simplest way to guarantee it succeeds regardless of who
      // owns the tmp dir.
      chmodSync(p, 0o644);
      return p;
    }

    function runValidator(envPath: string): SpawnSyncReturns<string> {
      return spawnSync('sudo', ['-n', 'bash', VALIDATE_SCRIPT, envPath], {
        encoding: 'utf8',
      });
    }

    const wellFormed = [
      `PROVIDERS_CONFIG='[{"name":"jira","routePath":"/hooks/jira","hmacSecret":"x","signatureStrategy":"websub","openclawHookUrl":"http://x"}]'`,
      `AGENTS_CONFIG='[{"name":"patch","statusName":"Plan"}]'`,
      `SECRETS_PROVIDERS_CONFIG='[{"name":"op","kind":"onepassword"}]'`,
      `SECRETS_CONFIG='[{"key":"OP_TOKEN","provider":"op"}]'`,
      '',
    ].join('\n');

    it('passes when every JSON value is single-quoted (well-formed file)', () => {
      const envPath = writeEnv('good.env', wellFormed);
      const result = runValidator(envPath);
      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    });

    it('fails with a clear message when a JSON value is unquoted', () => {
      // The bug — literal " inside an unquoted value gets stripped by
      // systemd's POSIX-shell parser, so the value reaching the unit is
      // either malformed JSON or empty after parsing.
      const body = wellFormed.replace(
        `PROVIDERS_CONFIG='[{"name":"jira","routePath":"/hooks/jira","hmacSecret":"x","signatureStrategy":"websub","openclawHookUrl":"http://x"}]'`,
        `PROVIDERS_CONFIG=[{"name":"jira","routePath":"/hooks/jira","hmacSecret":"x","signatureStrategy":"websub","openclawHookUrl":"http://x"}]`,
      );
      const envPath = writeEnv('unquoted.env', body);
      const result = runValidator(envPath);
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/PROVIDERS_CONFIG/);
      expect(combined).toMatch(/single quote/i);
    });

    it('fails and names the missing key when one of the four required keys is absent', () => {
      const body = wellFormed
        .split('\n')
        .filter((line) => !line.startsWith('AGENTS_CONFIG='))
        .join('\n');
      const envPath = writeEnv('missing-key.env', body);
      const result = runValidator(envPath);
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/AGENTS_CONFIG/);
      expect(combined).toMatch(/missing/i);
    });

    it('fails when a JSON value is the empty array — the runtime contract requires at least one entry', () => {
      const body = wellFormed.replace(
        `PROVIDERS_CONFIG='[{"name":"jira","routePath":"/hooks/jira","hmacSecret":"x","signatureStrategy":"websub","openclawHookUrl":"http://x"}]'`,
        `PROVIDERS_CONFIG='[]'`,
      );
      const envPath = writeEnv('empty-array.env', body);
      const result = runValidator(envPath);
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/PROVIDERS_CONFIG/);
      expect(combined).toMatch(/empty|non-empty/i);
    });
  },
);
