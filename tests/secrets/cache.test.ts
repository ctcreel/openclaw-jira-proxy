/**
 * Regression test for SPE-2005 — on-disk secrets cache.
 *
 * The bug: every clawndom restart re-shelled `op read` for every binding,
 * which combined with an unbounded systemd restart cadence DDoS'd 1Password
 * into rate-limiting the service account. The cache prevents that
 * amplification by serving fresh values from disk on subsequent boots.
 *
 * These tests cover the FileSecretCache contract:
 *   - write-then-read round-trip
 *   - mode 0600 enforcement (write side)
 *   - permission / corrupt-file / schema-mismatch handling (read side)
 *   - TTL staleness (per-entry + global ceiling)
 *   - clear() removes the file
 *   - atomic write via tmp + rename
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, promises as fs, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileSecretCache, NoOpSecretCache, type CachedSecretEntry } from '../../src/secrets/cache';

function entry(overrides: Partial<CachedSecretEntry> = {}): CachedSecretEntry {
  return {
    sourceProvider: 'onepassword',
    reference: 'op://Clawndom/jira/hmac',
    value: 'super-secret',
    resolvedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('FileSecretCache', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clawndom-cache-test-'));
    cachePath = join(dir, 'secrets.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('write-then-read round-trips entries', async () => {
    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    await cache.write(new Map([['jira_hmac', entry()]]));

    const read = await cache.read();
    expect(read.size).toBe(1);
    expect(read.get('jira_hmac')?.value).toBe('super-secret');
    expect(read.get('jira_hmac')?.reference).toBe('op://Clawndom/jira/hmac');
  });

  it('returns empty when the file does not exist', async () => {
    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    const read = await cache.read();
    expect(read.size).toBe(0);
  });

  it('writes the file at mode 0600', async () => {
    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    await cache.write(new Map([['k', entry()]]));
    const stat = statSync(cachePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('refuses to read a 0644 file (permission check)', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        writtenAt: new Date().toISOString(),
        entries: { jira_hmac: entry() },
      }),
    );
    await fs.chmod(cachePath, 0o644);

    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    const read = await cache.read();
    expect(read.size).toBe(0);
  });

  it('refuses to read a corrupt JSON file', async () => {
    writeFileSync(cachePath, '{not json');
    await fs.chmod(cachePath, 0o600);

    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    const read = await cache.read();
    expect(read.size).toBe(0);
  });

  it('refuses to read a schema-mismatched file (e.g. unsupported version)', async () => {
    writeFileSync(cachePath, JSON.stringify({ version: 99, writtenAt: 'now', entries: {} }));
    await fs.chmod(cachePath, 0o600);

    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    const read = await cache.read();
    expect(read.size).toBe(0);
  });

  it('honours per-entry ttlSeconds — drops a stale entry', async () => {
    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    await cache.write(
      new Map([['short_lived', entry({ resolvedAt: oneHourAgo, ttlSeconds: 60 })]]),
    );

    const read = await cache.read();
    expect(read.size).toBe(0);
  });

  it('honours global maxAgeSeconds when no per-entry ttlSeconds is set', async () => {
    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 60 });
    const fiveMinutesAgo = new Date(Date.now() - 300_000).toISOString();
    await cache.write(
      new Map([['static', entry({ resolvedAt: fiveMinutesAgo, ttlSeconds: undefined })]]),
    );

    const read = await cache.read();
    expect(read.size).toBe(0);
  });

  it('keeps fresh entries within the ttl window', async () => {
    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    await cache.write(
      new Map([['fresh', entry({ resolvedAt: new Date().toISOString(), ttlSeconds: 3_600 })]]),
    );

    const read = await cache.read();
    expect(read.get('fresh')?.value).toBe('super-secret');
  });

  it('clear() removes the file', async () => {
    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    await cache.write(new Map([['k', entry()]]));
    expect(existsSync(cachePath)).toBe(true);

    await cache.clear();
    expect(existsSync(cachePath)).toBe(false);
  });

  it('clear() is a no-op when the file does not exist', async () => {
    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    await expect(cache.clear()).resolves.toBeUndefined();
  });

  it('writes atomically via tmp + rename so a partial write cannot corrupt the cache', async () => {
    // Pre-seed a known-good cache file.
    const cache = new FileSecretCache({ path: cachePath, maxAgeSeconds: 86_400 });
    await cache.write(new Map([['k', entry({ value: 'v1' })]]));

    // Fail the rename to simulate a crash mid-write.
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated crash'));
    await expect(cache.write(new Map([['k', entry({ value: 'v2' })]]))).rejects.toThrow();
    renameSpy.mockRestore();

    // Original file content must still be the v1 payload — never the partial
    // v2 write — because we wrote to a sibling tmp file before the rename.
    const read = await cache.read();
    expect(read.get('k')?.value).toBe('v1');
  });
});

describe('NoOpSecretCache', () => {
  it('read returns empty', async () => {
    const cache = new NoOpSecretCache();
    expect((await cache.read()).size).toBe(0);
  });

  it('write is a no-op', async () => {
    const cache = new NoOpSecretCache();
    await expect(
      cache.write(
        new Map([
          [
            'k',
            {
              sourceProvider: 'p',
              reference: 'r',
              value: 'v',
              resolvedAt: new Date().toISOString(),
            },
          ],
        ]),
      ),
    ).resolves.toBeUndefined();
  });

  it('clear is a no-op', async () => {
    const cache = new NoOpSecretCache();
    await expect(cache.clear()).resolves.toBeUndefined();
  });
});
