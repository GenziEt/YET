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
let client = null;
export function getRedis() {
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
export async function cacheDel(key) {
    try {
        await getRedis().del(key);
    }
    catch { /* best-effort */ }
}
let fakeStore = null;
export function setFakeCache(store) { fakeStore = store; }
export async function cacheGetJson(key) {
    if (fakeStore) {
        const raw = fakeStore.get(key);
        return raw ? JSON.parse(raw) : null;
    }
    try {
        const raw = await getRedis().get(key);
        return raw ? JSON.parse(raw) : null;
    }
    catch {
        return null; // degraded: treat as miss
    }
}
export async function cacheSetJson(key, value, ttlSeconds) {
    if (fakeStore) {
        fakeStore.set(key, JSON.stringify(value), Math.max(1, Math.round(ttlSeconds)));
        return;
    }
    try {
        await getRedis().set(key, JSON.stringify(value), 'EX', Math.max(1, Math.round(ttlSeconds)));
    }
    catch {
        /* best-effort */
    }
}
/** Prefix scan for invalidation indexes (e.g. all route keys that were written
 *  through a given destination geofence). Uses SCAN (non-blocking), never KEYS. */
export async function cacheKeysByPrefix(prefix) {
    if (fakeStore)
        return fakeStore.keys(`${prefix}*`);
    const redis = getRedis();
    const out = [];
    try {
        let cursor = '0';
        do {
            const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
            cursor = next;
            out.push(...found);
        } while (cursor !== '0');
    }
    catch {
        return []; // degraded: invalidation falls back to TTL expiry only
    }
    return out;
}
export async function cacheDelMany(keys) {
    if (keys.length === 0)
        return;
    if (fakeStore) {
        for (const k of keys)
            fakeStore.del(k);
        return;
    }
    try {
        await getRedis().del(...keys);
    }
    catch { /* best-effort */ }
}
export async function closeRedis() {
    if (client) {
        await client.quit().catch(() => client?.disconnect());
        client = null;
    }
}
//# sourceMappingURL=redis.js.map