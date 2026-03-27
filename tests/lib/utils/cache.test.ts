import { describe, it, expect, vi } from 'vitest';

import { TtlCache } from '../../../src/lib/utils/cache';

describe('TtlCache', () => {
  it('should cache and retrieve values', () => {
    const cache = new TtlCache<string>(60);
    cache.set('key1', 'value1');
    const result = cache.get('key1');
    expect(result).toEqual({ found: true, value: 'value1' });
  });

  it('should return miss for unknown keys', () => {
    const cache = new TtlCache<string>(60);
    const result = cache.get('unknown');
    expect(result).toEqual({ found: false, value: null });
  });

  it('should expire entries', async () => {
    const cache = new TtlCache<string>(0.001); // 1ms TTL
    cache.set('key1', 'value1');

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = cache.get('key1');
    expect(result.found).toBe(false);
  });

  it('should track stats', () => {
    const cache = new TtlCache<string>(60);
    cache.set('key1', 'value1');
    cache.get('key1');
    cache.get('missing');

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });
});
