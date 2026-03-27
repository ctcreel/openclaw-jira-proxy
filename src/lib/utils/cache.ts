interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  expirations: number;
  evictions: number;
}

export class TtlCache<T> {
  private readonly ttlSeconds: number;
  private readonly maxSize: number;
  private cache = new Map<string, CacheEntry<T>>();
  private stats: CacheStats = { hits: 0, misses: 0, expirations: 0, evictions: 0 };

  constructor(ttlSeconds: number, maxSize: number = 0) {
    this.ttlSeconds = ttlSeconds;
    this.maxSize = maxSize;
  }

  get(key: string): { found: true; value: T } | { found: false; value: null } {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return { found: false, value: null };
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.expirations++;
      this.stats.misses++;
      return { found: false, value: null };
    }

    this.stats.hits++;
    return { found: true, value: entry.value };
  }

  set(key: string, value: T): void {
    if (this.maxSize > 0 && this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
  }

  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, expirations: 0, evictions: 0 };
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  hitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    if (total === 0) return 0;
    return this.stats.hits / total;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestExpiry = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }
  }
}

export function createTtlCache<TArgs extends unknown[], TReturn>(
  ttlSeconds: number = 300,
  options?: { maxSize?: number },
): (fn: (...args: TArgs) => TReturn) => ((...args: TArgs) => TReturn) & {
  clearCache: () => void;
  cacheStats: () => CacheStats;
} {
  return (fn) => {
    const cache = new TtlCache<TReturn>(ttlSeconds, options?.maxSize ?? 0);

    const wrapped = (...args: TArgs): TReturn => {
      const key = args.map((arg) => JSON.stringify(arg)).join(':');
      const result = cache.get(key);

      if (result.found) {
        return result.value;
      }

      const value = fn(...args);
      cache.set(key, value);
      return value;
    };

    wrapped.clearCache = (): void => cache.clear();
    wrapped.cacheStats = (): CacheStats => cache.getStats();

    return wrapped;
  };
}
