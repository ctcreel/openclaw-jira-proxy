/**
 * On-disk cache for resolved secrets — added in SPE-2005.
 *
 * Why this exists: a clawndom restart loop re-shelled `op read` for every
 * binding on every boot. ~5 secrets × ~720 restarts/hour ≈ 3,600 outbound
 * 1Password calls/hour, which exhausted the service-account rate limit and
 * locked the loop in. The cache breaks that amplification — once a secret
 * resolves successfully, subsequent boots read from a tmpfs file owned by
 * the clawndom user and only call slow providers for keys that are missing,
 * stale, or whose binding `reference` changed.
 *
 * Two implementations:
 *   - {@link FileSecretCache} — production: tmpfs-backed file at mode 0600
 *     with atomic write semantics (tmp file + rename). Defaults to
 *     /run/clawndom/secrets.json, provisioned by the systemd unit's
 *     RuntimeDirectory= directive.
 *   - {@link NoOpSecretCache} — tests / local dev where the cache is off.
 *
 * Invalidation has three independent triggers (a cache without invalidation
 * is a bug on a timer):
 *   1. Per-entry `ttlSeconds` — cached at write time from the binding's TTL.
 *   2. Global `maxAgeSeconds` — ceiling for entries with no per-binding TTL
 *      so a long-lived static key still gets re-fetched periodically.
 *   3. Operator escape hatch — `rm /run/clawndom/secrets.json` (or the
 *      `clear()` helper) forces a fresh fetch after rotating a secret.
 *
 * Defence-in-depth on read: refuse the file if its mode is broader than
 * 0600 or its owner UID differs from the running process's effective UID.
 * tmpfs + the systemd unit's `User=clawndom` already enforce this; the
 * checks make a tampered cache fail closed.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import { getLogger } from '../lib/logging';

const logger = getLogger('secret:cache');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CachedSecretEntry {
  /** Provider that resolved this value (must match the binding's provider on read). */
  sourceProvider: string;
  /** Locator used to resolve the value (must match the binding's reference on read). */
  reference: string;
  /** The resolved secret value. */
  value: string;
  /** ISO timestamp when the value was resolved. */
  resolvedAt: string;
  /** Optional refresh interval the binding declared at resolve time. */
  ttlSeconds?: number;
}

export interface SecretCache {
  /** Read all currently-fresh entries. Stale or invalid entries are filtered out. */
  read(): Promise<ReadonlyMap<string, CachedSecretEntry>>;
  /** Persist the given entries (full snapshot — anything not in `entries` is dropped). */
  write(entries: ReadonlyMap<string, CachedSecretEntry>): Promise<void>;
  /** Remove the cache file (defensive helper for ops). */
  clear(): Promise<void>;
}

export interface FileSecretCacheConfig {
  path: string;
  /** Global staleness ceiling for entries without per-binding ttlSeconds (seconds). */
  maxAgeSeconds: number;
}

// ---------------------------------------------------------------------------
// Cache file schema (versioned for forward compatibility)
// ---------------------------------------------------------------------------

const CACHE_FILE_VERSION = 1;

const cacheEntrySchema = z.object({
  sourceProvider: z.string().min(1),
  reference: z.string().min(1),
  value: z.string(),
  resolvedAt: z.string().min(1),
  ttlSeconds: z.number().positive().optional(),
});

const cacheFileSchema = z.object({
  version: z.literal(CACHE_FILE_VERSION),
  writtenAt: z.string().min(1),
  entries: z.record(z.string(), cacheEntrySchema),
});

// ---------------------------------------------------------------------------
// FileSecretCache — production implementation
// ---------------------------------------------------------------------------

export class FileSecretCache implements SecretCache {
  private readonly path: string;
  private readonly maxAgeSeconds: number;

  constructor(config: FileSecretCacheConfig) {
    this.path = config.path;
    this.maxAgeSeconds = config.maxAgeSeconds;
  }

  async read(): Promise<ReadonlyMap<string, CachedSecretEntry>> {
    const raw = await this.tryReadFile();
    if (raw === null) return new Map();

    if (!(await this.isOwnerAndModeSafe())) {
      return new Map();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn(
        { path: this.path, error: (err as Error).message },
        'Cache file is not valid JSON — ignoring',
      );
      return new Map();
    }

    const validated = cacheFileSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn(
        { path: this.path, error: validated.error.message },
        'Cache file schema mismatch — ignoring',
      );
      return new Map();
    }

    const now = Date.now();
    const result = new Map<string, CachedSecretEntry>();
    for (const [key, entry] of Object.entries(validated.data.entries)) {
      const resolvedAt = Date.parse(entry.resolvedAt);
      if (Number.isNaN(resolvedAt)) {
        logger.warn({ path: this.path, key }, 'Cache entry has unparseable resolvedAt — dropping');
        continue;
      }
      const effectiveTtl = entry.ttlSeconds ?? this.maxAgeSeconds;
      const ageSeconds = (now - resolvedAt) / 1000;
      if (ageSeconds > effectiveTtl) {
        logger.debug(
          { path: this.path, key, ageSeconds, effectiveTtl },
          'Cache entry stale — dropping',
        );
        continue;
      }
      result.set(key, entry);
    }
    return result;
  }

  async write(entries: ReadonlyMap<string, CachedSecretEntry>): Promise<void> {
    // Best-effort directory creation. systemd's RuntimeDirectory= has already
    // provisioned /run/clawndom on tmpfs at mode 0700; this catches local
    // dev where the cache is pointed at a non-tmpfs path.
    try {
      await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    } catch {
      // Directory may exist with stricter perms set by an operator; ignore.
    }

    const payload = {
      version: CACHE_FILE_VERSION,
      writtenAt: new Date().toISOString(),
      entries: Object.fromEntries(entries),
    };
    const json = JSON.stringify(payload);

    const tmpPath = `${this.path}.tmp`;
    // Atomic write via tmp + rename: a partial write before the rename
    // leaves the original file untouched, so a crash mid-write cannot
    // corrupt the cache. Mode 0600 is enforced on the tmp file before
    // rename so there is no observable window where a wider-permission
    // file exists on disk.
    await fs.writeFile(tmpPath, json, { mode: 0o600 });
    // Defensive chmod — Node honours `mode` on writeFile, but a strict
    // umask on some platforms can still narrow it; explicitly set 0o600
    // to make the post-condition unambiguous.
    try {
      await fs.chmod(tmpPath, 0o600);
    } catch {
      // chmod failure on the tmp file is not fatal; the rename below will
      // atomically replace the old file regardless.
    }
    await fs.rename(tmpPath, this.path);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  private async tryReadFile(): Promise<string | null> {
    try {
      return await fs.readFile(this.path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      logger.warn(
        { path: this.path, error: (err as Error).message },
        'Cache read failed — treating as empty',
      );
      return null;
    }
  }

  private async isOwnerAndModeSafe(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.path);
      const mode = stat.mode & 0o777;
      if (mode !== 0o600) {
        logger.warn(
          { path: this.path, mode: mode.toString(8) },
          'Cache file mode is not 0600 — refusing to trust',
        );
        return false;
      }
      const expectedUid = process.geteuid?.();
      if (expectedUid !== undefined && stat.uid !== expectedUid) {
        logger.warn(
          { path: this.path, uid: stat.uid, expectedUid },
          'Cache file owner does not match the process — refusing to trust',
        );
        return false;
      }
      return true;
    } catch (err) {
      logger.warn(
        { path: this.path, error: (err as Error).message },
        'Cache stat failed — refusing to trust',
      );
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// NoOpSecretCache — for tests and local dev where the cache is disabled
// ---------------------------------------------------------------------------

export class NoOpSecretCache implements SecretCache {
  async read(): Promise<ReadonlyMap<string, CachedSecretEntry>> {
    return new Map();
  }

  async write(): Promise<void> {
    // Intentionally empty.
  }

  async clear(): Promise<void> {
    // Intentionally empty.
  }
}
