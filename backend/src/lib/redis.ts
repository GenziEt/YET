import Redis from 'ioredis';
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

export async function closeRedis(): Promise<void> {
  if (client) { await client.quit().catch(() => client?.disconnect()); client = null; }
}
