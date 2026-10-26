import { Redis } from 'ioredis'; // named import: correct under NodeNext ESM interop
import { env } from '../config/env.js';

/**
 * Shared Redis client (§1.10.2). Provisioned since Phase 0 in Docker Compose so
 * caching is available when needed, not retrofitted. Consumers:
 *   - OSM Gateway route cache (Phase 3, TTL 5 min)
 *   - Nominatim geocode cache (Phase 3, TTL 24 h)
 *   - dashboard fleet-state query cache (Phase 5, TTL 30 s)
 *
 * Resilience contract: YET must keep working when Redis is down — every helper
 * degrades to a miss instead of throwing. A cache outage costs latency budget,
 * never correctness.
 */
let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false, // fail fast -> caller treats as cache miss
      retryStrategy: (times) => Math.min(times * 200, 3000),
      lazyConnect: false,
    });
    client.on('error', (err) => {
      // Never crash the monolith on Redis flakiness; log for alerting.
      console.warn('[redis] error:', err.message);
    });
  }
  return client;
}

export async function cacheGetJson<T = unknown>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // degraded: treat as miss
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', Math.max(1, Math.round(ttlSeconds)));
  } catch {
    /* best-effort */
  }
}

export async function cacheDel(key: string): Promise<void> {
  try { await getRedis().del(key); } catch { /* best-effort */ }
}

/** Test seam (Phase 3 gate tests): install a fake cache store and every helper
 *  below operates on it instead of the live Redis client — no container needed
 *  to lock down hit/miss/TTL/invalidation semantics. Passing `null` restores
 *  the real client. NEVER used by the production bootstrap; only tests call it. */
export interface FakeCacheStore {
  get(key: string): string | null;
  set(key: string, value: string, ttlSeconds: number): void;
  del(key: string): void;
  keys(pattern: string): string[];
}
let fakeStore: FakeCacheStore | null = null;
export function setFakeCache(store: FakeCacheStore | null): void { fakeStore = store; }

export async function cacheGetJson<T = unknown>(key: string): Promise<T | null> {
  if (fakeStore) {
    const raw = fakeStore.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // degraded: treat as miss
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (fakeStore) {
    fakeStore.set(key, JSON.stringify(value), Math.max(1, Math.round(ttlSeconds)));
    return;
  }
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', Math.max(1, Math.round(ttlSeconds)));
  } catch {
    /* best-effort */
  }
}

/** Prefix scan for invalidation indexes (e.g. all route keys that were written
 *  through a given destination geofence). Uses SCAN (non-blocking), never KEYS. */
export async function cacheKeysByPrefix(prefix: string): Promise<string[]> {
  if (fakeStore) return fakeStore.keys(`${prefix}*`);
  const redis = getRedis();
  const out: string[] = [];
  try {
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      out.push(...found);
    } while (cursor !== '0');
  } catch {
    return []; // degraded: invalidation falls back to TTL expiry only
  }
  return out;
}

export async function cacheDelMany(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (fakeStore) { for (const k of keys) fakeStore.del(k); return; }
  try { await getRedis().del(...keys); } catch { /* best-effort */ }
}

export async function closeRedis(): Promise<void> {
  if (client) { await client.quit().catch(() => client?.disconnect()); client = null; }
}
