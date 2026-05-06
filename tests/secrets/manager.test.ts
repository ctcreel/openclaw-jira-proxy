import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SecretManager } from '../../src/secrets/manager';
import { registerSecretProvider, resetSecretProviders } from '../../src/secrets/registry';
import type { CachedSecretEntry, SecretCache } from '../../src/secrets/cache';
import type { SecretProvider, SecretBinding } from '../../src/secrets/types';

class MockProvider implements SecretProvider {
  readonly name = 'mock';
  readonly resolveFn = vi.fn<[readonly SecretBinding[]], Promise<ReadonlyMap<string, string>>>();

  async resolve(bindings: readonly SecretBinding[]): Promise<ReadonlyMap<string, string>> {
    return this.resolveFn(bindings);
  }
}

describe('SecretManager', () => {
  let mockProvider: MockProvider;

  beforeEach(() => {
    resetSecretProviders();
    mockProvider = new MockProvider();
    registerSecretProvider(mockProvider);
  });

  it('should resolve secrets on initialize', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map([['api_key', 'secret-123']]));

    const bindings: SecretBinding[] = [
      { key: 'api_key', provider: 'mock', reference: 'some-ref', required: true },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    expect(manager.getSecret('api_key')).toBe('secret-123');
    manager.close();
  });

  it('should throw on getSecret for unknown key', async () => {
    const manager = new SecretManager([]);
    await manager.initialize();

    expect(() => manager.getSecret('nonexistent')).toThrow('Secret "nonexistent" not found');
    manager.close();
  });

  it('should fail startup when required secret is missing', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map());

    const bindings: SecretBinding[] = [
      { key: 'required_secret', provider: 'mock', reference: 'ref', required: true },
    ];
    const manager = new SecretManager(bindings);

    await expect(manager.initialize()).rejects.toThrow(
      'Required secret "required_secret" could not be resolved',
    );
    manager.close();
  });

  it('should warn but not fail for optional missing secrets', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map());

    const bindings: SecretBinding[] = [
      { key: 'optional_secret', provider: 'mock', reference: 'ref', required: false },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    expect(manager.hasSecret('optional_secret')).toBe(false);
    manager.close();
  });

  it('should report healthy when all required secrets are resolved', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map([['key', 'value']]));

    const bindings: SecretBinding[] = [
      { key: 'key', provider: 'mock', reference: 'ref', required: true },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    expect(manager.isHealthy()).toBe(true);
    manager.close();
  });

  it('should report unhealthy when required secret is missing', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map([['other', 'value']]));

    const bindings: SecretBinding[] = [
      { key: 'key', provider: 'mock', reference: 'ref', required: false },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    // hasSecret returns false for unresolved optional secret
    expect(manager.hasSecret('key')).toBe(false);
    // But isHealthy still true because it's not required
    expect(manager.isHealthy()).toBe(true);
    manager.close();
  });

  it('should resolve multiple secrets from same provider in batch', async () => {
    mockProvider.resolveFn.mockResolvedValue(
      new Map([
        ['secret_a', 'value-a'],
        ['secret_b', 'value-b'],
      ]),
    );

    const bindings: SecretBinding[] = [
      { key: 'secret_a', provider: 'mock', reference: 'ref-a', required: true },
      { key: 'secret_b', provider: 'mock', reference: 'ref-b', required: true },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    expect(mockProvider.resolveFn).toHaveBeenCalledOnce();
    expect(manager.getSecret('secret_a')).toBe('value-a');
    expect(manager.getSecret('secret_b')).toBe('value-b');
    manager.close();
  });

  it('should update secret value in memory', async () => {
    mockProvider.resolveFn.mockResolvedValue(new Map([['key', 'old-value']]));

    const bindings: SecretBinding[] = [
      { key: 'key', provider: 'mock', reference: 'ref', required: true },
    ];
    const manager = new SecretManager(bindings);
    await manager.initialize();

    manager.updateSecret('key', 'new-value');
    expect(manager.getSecret('key')).toBe('new-value');
    manager.close();
  });

  it('should handle empty bindings gracefully', async () => {
    const manager = new SecretManager([]);
    await manager.initialize();
    expect(manager.isHealthy()).toBe(true);
    manager.close();
  });

  describe('refresh timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('schedules periodic refresh when a binding has a ttl', async () => {
      mockProvider.resolveFn.mockResolvedValue(new Map([['key', 'v1']]));
      const bindings: SecretBinding[] = [
        { key: 'key', provider: 'mock', reference: 'ref', required: true, ttlSeconds: 120 },
      ];
      const manager = new SecretManager(bindings);
      await manager.initialize();

      // Second resolve returns a fresh value
      mockProvider.resolveFn.mockResolvedValue(new Map([['key', 'v2']]));

      // Advance time past the refresh interval (120s - 60s = 60s refresh window)
      await vi.advanceTimersByTimeAsync(61_000);

      expect(manager.getSecret('key')).toBe('v2');
      manager.close();
    });

    it('ignores bindings without a ttl', async () => {
      mockProvider.resolveFn.mockResolvedValue(new Map([['key', 'v1']]));
      const bindings: SecretBinding[] = [
        { key: 'key', provider: 'mock', reference: 'ref', required: true },
      ];
      const manager = new SecretManager(bindings);
      await manager.initialize();

      mockProvider.resolveFn.mockClear();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(mockProvider.resolveFn).not.toHaveBeenCalled();
      manager.close();
    });

    it('batches refresh of bindings sharing the same provider + ttl', async () => {
      mockProvider.resolveFn.mockResolvedValue(
        new Map([
          ['a', '1'],
          ['b', '2'],
        ]),
      );
      const bindings: SecretBinding[] = [
        { key: 'a', provider: 'mock', reference: 'ra', required: true, ttlSeconds: 120 },
        { key: 'b', provider: 'mock', reference: 'rb', required: true, ttlSeconds: 120 },
      ];
      const manager = new SecretManager(bindings);
      await manager.initialize();

      mockProvider.resolveFn.mockClear();
      mockProvider.resolveFn.mockResolvedValue(
        new Map([
          ['a', '1b'],
          ['b', '2b'],
        ]),
      );
      await vi.advanceTimersByTimeAsync(61_000);

      // Both keys refreshed in a single provider call
      expect(mockProvider.resolveFn).toHaveBeenCalledTimes(1);
      expect(manager.getSecret('a')).toBe('1b');
      expect(manager.getSecret('b')).toBe('2b');
      manager.close();
    });

    it('tolerates a transient refresh failure without crashing', async () => {
      mockProvider.resolveFn.mockResolvedValueOnce(new Map([['key', 'v1']]));
      const bindings: SecretBinding[] = [
        { key: 'key', provider: 'mock', reference: 'ref', required: false, ttlSeconds: 120 },
      ];
      const manager = new SecretManager(bindings);
      await manager.initialize();

      mockProvider.resolveFn.mockRejectedValueOnce(new Error('provider down'));
      await vi.advanceTimersByTimeAsync(61_000);

      // Last-known-good value stays available
      expect(manager.getSecret('key')).toBe('v1');
      manager.close();
    });
  });

  // ---------------------------------------------------------------------------
  // SPE-2005 — secrets cache integration
  // ---------------------------------------------------------------------------
  describe('with secrets cache (SPE-2005)', () => {
    let mockCache: {
      read: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      clear: ReturnType<typeof vi.fn>;
    } & SecretCache;

    // Helper for cache entries used across these tests. Keeps the per-test
    // bodies focused on the field that varies (value, reference, etc.)
    // rather than re-declaring sourceProvider + resolvedAt every time.
    function cachedEntry(overrides: Partial<CachedSecretEntry> = {}): CachedSecretEntry {
      return {
        sourceProvider: 'mock',
        reference: 'r1',
        value: 'v1',
        resolvedAt: new Date().toISOString(),
        ...overrides,
      };
    }

    beforeEach(() => {
      mockCache = {
        read: vi.fn().mockResolvedValue(new Map<string, CachedSecretEntry>()),
        write: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      } as unknown as typeof mockCache;
    });

    it('cache hit for all keys → provider.resolve is NOT called', async () => {
      mockCache.read.mockResolvedValue(new Map<string, CachedSecretEntry>([['k1', cachedEntry()]]));
      const bindings: SecretBinding[] = [
        { key: 'k1', provider: 'mock', reference: 'r1', required: true },
      ];
      const manager = new SecretManager(bindings, { cache: mockCache });
      await manager.initialize();

      expect(mockProvider.resolveFn).not.toHaveBeenCalled();
      expect(manager.getSecret('k1')).toBe('v1');
      manager.close();
    });

    it('cache hit for some, miss for others → provider called with only the missed bindings', async () => {
      mockCache.read.mockResolvedValue(
        new Map<string, CachedSecretEntry>([
          ['cached', cachedEntry({ reference: 'rc', value: 'cached-val' })],
        ]),
      );
      mockProvider.resolveFn.mockResolvedValue(new Map([['fresh', 'fresh-val']]));

      const bindings: SecretBinding[] = [
        { key: 'cached', provider: 'mock', reference: 'rc', required: true },
        { key: 'fresh', provider: 'mock', reference: 'rf', required: true },
      ];
      const manager = new SecretManager(bindings, { cache: mockCache });
      await manager.initialize();

      expect(mockProvider.resolveFn).toHaveBeenCalledOnce();
      const calledWith = mockProvider.resolveFn.mock.calls[0]![0];
      expect(calledWith).toHaveLength(1);
      expect(calledWith[0]!.key).toBe('fresh');
      expect(manager.getSecret('cached')).toBe('cached-val');
      expect(manager.getSecret('fresh')).toBe('fresh-val');
      manager.close();
    });

    it('reference change → cache miss for that key, provider re-fetches', async () => {
      mockCache.read.mockResolvedValue(
        new Map<string, CachedSecretEntry>([
          ['k1', cachedEntry({ reference: 'old-ref', value: 'old' })],
        ]),
      );
      mockProvider.resolveFn.mockResolvedValue(new Map([['k1', 'new']]));

      const bindings: SecretBinding[] = [
        { key: 'k1', provider: 'mock', reference: 'new-ref', required: true },
      ];
      const manager = new SecretManager(bindings, { cache: mockCache });
      await manager.initialize();

      expect(mockProvider.resolveFn).toHaveBeenCalledOnce();
      expect(manager.getSecret('k1')).toBe('new');
      manager.close();
    });

    it('provider returns missing required key on cache miss → still throws', async () => {
      mockCache.read.mockResolvedValue(new Map());
      mockProvider.resolveFn.mockResolvedValue(new Map());

      const bindings: SecretBinding[] = [
        { key: 'required_k', provider: 'mock', reference: 'r', required: true },
      ];
      const manager = new SecretManager(bindings, { cache: mockCache });
      await expect(manager.initialize()).rejects.toThrow(
        'Required secret "required_k" could not be resolved',
      );
      manager.close();
    });

    it('cache write happens after provider success, not before (avoids persisting failed resolutions)', async () => {
      let counter = 0;
      let providerCalledAt = -1;
      let writeCalledAt = -1;
      mockProvider.resolveFn.mockImplementation(async () => {
        providerCalledAt = ++counter;
        return new Map([['k', 'v']]);
      });
      mockCache.write.mockImplementation(async () => {
        writeCalledAt = ++counter;
      });

      const bindings: SecretBinding[] = [
        { key: 'k', provider: 'mock', reference: 'r', required: true },
      ];
      const manager = new SecretManager(bindings, { cache: mockCache });
      await manager.initialize();

      expect(providerCalledAt).toBeGreaterThan(0);
      expect(writeCalledAt).toBeGreaterThan(providerCalledAt);
      manager.close();
    });

    it('writes only the resolved keys to the cache (omits failed resolutions)', async () => {
      mockCache.read.mockResolvedValue(new Map());
      mockProvider.resolveFn.mockResolvedValue(new Map([['ok', 'val']]));

      const bindings: SecretBinding[] = [
        { key: 'ok', provider: 'mock', reference: 'r1', required: true },
        { key: 'optional_missing', provider: 'mock', reference: 'r2', required: false },
      ];
      const manager = new SecretManager(bindings, { cache: mockCache });
      await manager.initialize();

      expect(mockCache.write).toHaveBeenCalledOnce();
      const written = mockCache.write.mock.calls[0]![0] as Map<string, CachedSecretEntry>;
      expect(written.has('ok')).toBe(true);
      expect(written.has('optional_missing')).toBe(false);
      manager.close();
    });

    it('writes the partial cache before throwing on a required miss (so successes survive a restart)', async () => {
      mockCache.read.mockResolvedValue(new Map());
      mockProvider.resolveFn.mockResolvedValue(new Map([['ok', 'val']]));

      const bindings: SecretBinding[] = [
        { key: 'ok', provider: 'mock', reference: 'r1', required: true },
        { key: 'missing_required', provider: 'mock', reference: 'r2', required: true },
      ];
      const manager = new SecretManager(bindings, { cache: mockCache });
      await expect(manager.initialize()).rejects.toThrow(
        'Required secret "missing_required" could not be resolved',
      );

      expect(mockCache.write).toHaveBeenCalledOnce();
      const written = mockCache.write.mock.calls[0]![0] as Map<string, CachedSecretEntry>;
      expect(written.has('ok')).toBe(true);
      expect(written.has('missing_required')).toBe(false);
      manager.close();
    });

    it('refresh cycle writes through to the cache', async () => {
      vi.useFakeTimers();
      try {
        mockProvider.resolveFn.mockResolvedValue(new Map([['k', 'v1']]));
        const bindings: SecretBinding[] = [
          { key: 'k', provider: 'mock', reference: 'r', required: true, ttlSeconds: 120 },
        ];
        const manager = new SecretManager(bindings, { cache: mockCache });
        await manager.initialize();

        mockCache.write.mockClear();
        mockProvider.resolveFn.mockResolvedValue(new Map([['k', 'v2']]));
        await vi.advanceTimersByTimeAsync(61_000);

        expect(mockCache.write).toHaveBeenCalled();
        const lastWrite = mockCache.write.mock.calls[
          mockCache.write.mock.calls.length - 1
        ]![0] as Map<string, CachedSecretEntry>;
        expect(lastWrite.get('k')?.value).toBe('v2');

        manager.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('survives a cache.write() failure without breaking startup', async () => {
      mockCache.read.mockResolvedValue(new Map());
      mockCache.write.mockRejectedValue(new Error('disk full'));
      mockProvider.resolveFn.mockResolvedValue(new Map([['k', 'v']]));

      const bindings: SecretBinding[] = [
        { key: 'k', provider: 'mock', reference: 'r', required: true },
      ];
      const manager = new SecretManager(bindings, { cache: mockCache });
      await expect(manager.initialize()).resolves.toBeUndefined();
      expect(manager.getSecret('k')).toBe('v');
      manager.close();
    });
  });
});
