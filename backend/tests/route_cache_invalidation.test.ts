/**
 * Phase 3 gate tests — Redis route caching, invalidation rules, and OSRM retry
 * handling, WITHOUT containers. Uses the FakeCacheStore seam (src/lib/redis.ts)
 * and the injectable fetch seam (src/modules/osm_gateway/service.ts). The
 * Postgres companion cache. The suite TRUNCATEs route_cache in beforeEach so
 * results are hermetic whether or not a live scratch DB is reachable (pg legs
 * degrade to a miss on an unreachable host by contract — pgRouteLookup/
 * pgRouteUpsert swallow errors), so these tests exercise exactly the Redis +
 * OSRM legs of getRoute.
 *
 * Covers the instruction items:
 *  - "Redis caching … fully wired with invalidation rules" → hit/miss/TTL and
 *    invalidateRoutesForGeofence dropping dest-indexed entries + fleet-state.
 *  - "OSRM routing client … failures, timeouts, and retries are handled" →
 *    bounded retry on network aborts ONLY; HTTP responses descend the ladder
 *    immediately; total failure yields the honest straight-line fallback.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// env.ts fail-fasts at import time without these (inert contract, same pattern
// as tests/osm_gateway.test.ts — no live connection is ever made for these paths).
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://yet:test@127.0.0.1:1/yet_none'; // closed port ⇒ pg legs degrade to miss
process.env.JWT_SECRET ??= 'route-cache-test-secret-0123456789abcdef';
process.env.OSRM_RETRY_BACKOFF_MS = '0'; // keep the suite fast; policy unchanged

const redis = await import('../src/lib/redis.js');
const svc = await import('../src/modules/osm_gateway/service.js');
const { routeCacheKey } = await import('../src/modules/osm_gateway/geo.js');

/* ------------------------------- fake cache --------------------------------- */
interface Entry { v: string; expiresAt: number }
const nowRef = () => Date.now(); // same clock the fake store stamps entries with
function makeFake() {
  const map = new Map<string, Entry>();
  const now = nowRef;
  const store: redis.FakeCacheStore = {
    get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (e.expiresAt <= now()) { map.delete(key); return null; }
      return e.v;
    },
    set(key, value, ttlSeconds) { map.set(key, { v: value, expiresAt: now() + ttlSeconds * 1000 }); },
    del(key) { map.delete(key); },
    keys(pattern) {
      const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return [...map.keys()].filter((k) => {
        if (!re.test(k)) return false;
        const e = map.get(k)!;
        if (e.expiresAt > now()) return true;
        map.delete(k); return false;
      });
    },
  };
  return { store, map };
}

const { pool } = await import('../src/db/pool.js');

let fake: ReturnType<typeof makeFake>;
// The suite's Postgres companion-cache leg is exercised against a live scratch
// DB when YET_TEST_DB/DATABASE_URL points at one (full-suite runs). To keep the
// Redis + OSRM legs hermetic, snapshot route_cache once and TRUNCATE it for the
// duration of the file; afterEach restores only rows this process created
// (cache_key prefix 'r:' — foreign keys never reference route_cache, so a
// truncate-restore cycle is safe). On the closed-port default every statement
// rejects and is swallowed (no-op).
async function pg(q: string): Promise<void> {
  try { await pool.query(q); } catch { /* unreachable DB ⇒ no-op by contract */ }
}

beforeAll(async () => {
  await pg(`DROP TABLE IF EXISTS route_cache_test_snapshot`);
  await pg(`CREATE TABLE route_cache_test_snapshot AS SELECT * FROM route_cache WHERE cache_key LIKE 'yet:route%'`);
  await pg(`DELETE FROM route_cache WHERE cache_key LIKE 'yet:route%'`);
});

afterAll(async () => {
  await pg(`INSERT INTO route_cache SELECT * FROM route_cache_test_snapshot`);
  await pg(`DROP TABLE route_cache_test_snapshot`);
});

beforeEach(async () => {
  fake = makeFake();
  redis.setFakeCache(fake.store);
  // Per-test isolation within the file: drop rows written by earlier tests.
  await pg(`DELETE FROM route_cache WHERE cache_key LIKE 'yet:route%'`);
});
afterEach(async () => {
  redis.setFakeCache(null);
  svc.setFetchForTesting(null);
});

const FROM = { lat: 9.0300, lng: 38.7400 };
const TO = { lat: 8.9800, lng: 38.7900 };
const ZONE = '00000000-0000-4000-8000-0000000000a1'; // valid uuid: pgRouteUpsert keys are persisted; geofence_id is a uuid column

/** Valid OSRM /route response (two-point polyline "_p~iF~ps|U_ulLnnqC" would be
 *  real; these trivial encodings decode cleanly: each coord delta zero). */
const osrmOk = (distance = 12_345, duration = 1_800) => ({
  ok: true, status: 200,
  json: async () => ({ code: 'Ok', routes: [{ distance, duration, geometry: '____@___A' }] }),
});

describe('getRoute — Redis hit/miss behavior', () => {
  it('miss → OSRM call → write-through to Redis with the 5-minute TTL', async () => {
    let calls = 0;
    svc.setFetchForTesting(async () => { calls++; return osrmOk(); });
    const key = routeCacheKey(FROM, TO);

    const r1 = await svc.getRoute(FROM, TO);
    expect(r1.source).toBe('osrm');
    expect(calls).toBe(1);

    const raw = fake.map.get(key);
    expect(raw).toBeDefined();
    // FakeCacheStore records absolute expiry; assert against the store's own clock.
    const ttlMs = raw!.expiresAt - nowRef();
    expect(ttlMs).toBeGreaterThan(290_000); // ≈ ROUTE_TTL_S=300 minus test latency
    expect(ttlMs).toBeLessThanOrEqual(300_000);

    // Second call: pure Redis hit — transport NEVER touched (§1.9.4 ≤50 ms path).
    const r2 = await svc.getRoute(FROM, TO);
    expect(r2.source).toBe('redis');
    expect(r2.distance_m).toBe(12_345);
    expect(calls).toBe(1);
  });

  it('expired Redis entry is treated as a miss and refetched', async () => {
    const key = routeCacheKey(FROM, TO);
    fake.map.set(key, { v: JSON.stringify({ ...({} as never), from: FROM, to: TO, distance_m: 1, duration_s: 1, geometry: [], source: 'osrm', cached_at: 'x' }), expiresAt: Date.now() - 1 });
    let calls = 0;
    svc.setFetchForTesting(async () => { calls++; return osrmOk(999, 99); });
    const r = await svc.getRoute(FROM, TO);
    expect(calls).toBe(1);
    expect(r.source).toBe('osrm');
    expect(r.distance_m).toBe(999);
  });
});

describe('invalidateRoutesForGeofence — Phase 3 invalidation rules', () => {
  it('a zone edit drops exactly the route entries indexed against its centroid', async () => {
    svc.setFetchForTesting(async () => osrmOk());
    const route = await svc.getRoute(FROM, TO, { destinationGeofenceId: ZONE });
    const key = routeCacheKey(FROM, TO);
    expect(fake.map.has(key)).toBe(true);
    expect(await redis.cacheGetJson<string[]>(svc.destIndexKey(ZONE))).toEqual([key]);

    // A dependent fleet-state snapshot also exists; it must be dropped too.
    await redis.cacheSetJson('fleet:state', { vehicles: [] }, 30);

    await svc.invalidateRoutesForGeofence(ZONE);

    expect(fake.map.has(key)).toBe(false);            // stale ETA gone
    expect(fake.map.has(svc.destIndexKey(ZONE))) .toBe(false); // index consumed
    expect(fake.map.has('fleet:state')).toBe(false);  // badges rebuild

    // Next read recomputes from OSRM — never serves the pre-edit geometry.
    let fresh = false;
    svc.setFetchForTesting(async () => { fresh = true; return osrmOk(500, 60); });
    const after = await svc.getRoute(FROM, TO, { destinationGeofenceId: ZONE });
    expect(fresh).toBe(true);
    expect(after.source).toBe('osrm');
    expect(after.distance_m).toBe(500);
  });

  it('routes NOT tied to the edited zone survive invalidation (precision rule)', async () => {
    svc.setFetchForTesting(async () => osrmOk());
    await svc.getRoute(FROM, TO, { destinationGeofenceId: ZONE });
    const otherTo = { lat: 9.1000, lng: 38.8000 };
    const otherKey = routeCacheKey(FROM, otherTo);
    await svc.getRoute(FROM, otherTo); // no destination zone
    await svc.invalidateRoutesForGeofence(ZONE);
    expect(fake.map.has(routeCacheKey(FROM, TO))).toBe(false);
    expect(fake.map.has(otherKey)).toBe(true);
  });

  it('invalidation is safe when nothing was ever indexed (no-op, no throw)', async () => {
    await expect(svc.invalidateRoutesForGeofence('00000000-0000-4000-8000-0000000000ff')).resolves.toBeUndefined();
  });
});

describe('OSRM failure handling — bounded retry + degradation ladder', () => {
  it('network abort (connection refused) is retried up to OSRM_RETRY_ATTEMPTS, then succeeds', async () => {
    let calls = 0;
    svc.setFetchForTesting(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error(' aborted'), { name: 'AbortError' });
      return osrmOk(4321, 321);
    });
    const r = await svc.getRoute({ lat: 9.01, lng: 38.71 }, { lat: 9.02, lng: 38.72 });
    expect(r.source).toBe('osrm');
    expect(r.distance_m).toBe(4321);
    expect(calls).toBe(2); // initial + exactly one retry (default OSRM_RETRY_ATTEMPTS=1)
  });

  it('persistent network failure exhausts retries and lands on the labeled straight-line fallback', async () => {
    let calls = 0;
    svc.setFetchForTesting(async () => {
      calls++;
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5000'), { code: 'ECONNREFUSED' });
    });
    const from = { lat: 9.05, lng: 38.75 };
    const to = { lat: 9.06, lng: 38.76 };
    const r = await svc.getRoute(from, to);
    expect(calls).toBe(1 + (process.env.OSRM_RETRY_ATTEMPTS ? Number(process.env.OSRM_RETRY_ATTEMPTS) : 1));
    expect(r.source).toBe('fallback_straight');
    // Fallback is honestly labeled and briefly cached (30 s anti-flap TTL).
    const key = routeCacheKey(from, to);
    const raw = fake.map.get(key);
    expect(raw).toBeDefined();
    expect(raw!.expiresAt - Date.now()).toBeLessThanOrEqual(30_000);
  });

  it('HTTP 5xx response is NEVER retried — descends the ladder immediately', async () => {
    let calls = 0;
    svc.setFetchForTesting(async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    });
    const r = await svc.getRoute({ lat: 9.07, lng: 38.77 }, { lat: 9.08, lng: 38.78 });
    expect(calls).toBe(1); // deterministic per input — hammering wastes the 800 ms budget
    expect(r.source).toBe('fallback_straight');
  });

  it('HTTP 404 response is never retried either', async () => {
    let calls = 0;
    svc.setFetchForTesting(async () => {
      calls++;
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await svc.getRoute({ lat: 9.11, lng: 38.81 }, { lat: 9.12, lng: 38.82 });
    expect(calls).toBe(1);
  });

  it('a non-network programming error is NOT retried and NOT masked by the ladder', async () => {
    let calls = 0;
    svc.setFetchForTesting(async () => {
      calls++;
      throw new TypeError('invalid url usage'); // not AbortError, no network code
    });
    await expect(svc.getRoute({ lat: 9.17, lng: 38.87 }, { lat: 9.18, lng: 38.88 }))
      .rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  it('OSRM code!=Ok throws deterministically (bad corridor request) → fallback, no retry', async () => {
    let calls = 0;
    svc.setFetchForTesting(async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ code: 'NoRoute' }) };
    });
    const r = await svc.getRoute({ lat: 9.13, lng: 38.83 }, { lat: 9.14, lng: 38.84 });
    expect(calls).toBe(1);
    expect(r.source).toBe('fallback_straight');
  });

  it('timeout via AbortController counts as a network abort (retried once)', async () => {
    let calls = 0;
    svc.setFetchForTesting(async () => {
      calls++;
      // Simulate the fetchWithTimeout AbortController firing: reject with the
      // DOMException-shaped abort error global fetch uses.
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    const r = await svc.getRoute({ lat: 9.15, lng: 38.85 }, { lat: 9.16, lng: 38.86 });
    expect(calls).toBe(2); // 1 + OSRM_RETRY_ATTEMPTS
    expect(r.source).toBe('fallback_straight');
  });
});
