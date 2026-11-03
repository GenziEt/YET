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
/* ---------------------------------------------------------------------------
 * FAIL-CRITICAL variants (production-readiness audit, P1 "silent OTP write").
 *
 * The degradation contract above (cache outage = miss, never correctness loss)
 * is right for ROUTE/GEOCODE/FLEET-STATE caches. It is WRONG for OTP codes and
 * registration tickets: those keys ARE the authentication state. If Redis is
 * down and cacheSetJson swallows the error, the driver is told "code sent"
 * while nothing was stored — they can never verify, and an operator reading
 * logs believes delivery succeeded. Availability theatre that breaks auth must
 * fail closed instead: these variants RE-THROW on cache errors so the route
 * returns 503 rather than a false success. Use them for every key whose
 * absence denies service to a legitimate user (otp:{phone}, otp_ticket:*).
 * ------------------------------------------------------------------------- */
export async function cacheSetJsonCritical(key, value, ttlSeconds) {
    const payload = JSON.stringify(value);
    const ttl = Math.max(1, Math.round(ttlSeconds));
    if (fakeStore) {
        fakeStore.set(key, payload, ttl);
        return;
    }
    await getRedis().set(key, payload, 'EX', ttl); // throws -> caller answers 503
}
/** Read counterpart for auth-state keys: a Redis ERROR must be distinguishable
 *  from a MISS. cacheGetJson collapses both into null (correct for caches);
 *  here a thrown error means "we cannot tell", and the caller must NOT treat
 *  it as "no code stored" — that would let an outage masquerade as an invalid
 *  OTP (wrong retry semantics, misleading audits). Throws on transport error. */
export async function cacheGetJsonCritical(key) {
    if (fakeStore) {
        const raw = fakeStore.get(key);
        return raw ? JSON.parse(raw) : null;
    }
    const raw = await getRedis().get(key); // throws -> caller answers 503
    return raw ? JSON.parse(raw) : null;
}
/** Del counterpart for one-shot auth keys: consuming an OTP/ticket MUST be
 *  confirmed. A swallowed error here would allow replay of a verified code.
 *  Throws on transport error. */
export async function cacheDelCritical(key) {
    if (fakeStore) {
        fakeStore.del(key);
        return;
    }
    await getRedis().del(key); // throws -> surfaced to caller
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