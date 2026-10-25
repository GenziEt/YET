import { env } from '../../config/env.js';
import { cacheGetJson, cacheSetJson } from '../../lib/redis.js';
import { pool } from '../../db/pool.js';
import { haversineM } from '../trip_engine/state_machine.js';
import { decodePolyline, routeCacheKey, geocodeCacheKey, roundCoord, } from './geo.js';
/**
 * Module 7 — OSM Gateway service (§1.5). Wraps ALL calls to the self-hosted
 * OSRM (routing) and Nominatim (geocoding). Nothing else may talk to them
 * directly — one place enforces caching, timeouts, and User-Agent compliance.
 *
 * Caching (§1.10.2, budgets §1.9.4):
 *   GET /route cached   ≤ 50 ms  → Redis hit short-circuits everything.
 *   GET /route uncached ≤ 800 ms → OSRM call budgeted at OSRM_TIMEOUT_MS.
 * Route TTL: 5 minutes for identical origin/destination pairs (blueprint-mandated).
 * Geocode TTL: 24 hours (addresses change ~never; Nominatim import cadence is weekly).
 *
 * Degradation ladder when OSRM is unreachable (e.g. container restarting during
 * a pilot): serve stale Redis entry → serve unexpired Postgres route_cache row →
 * straight-line fallback with explicit `source: 'fallback_straight'` so the UI can
 * label it honestly. ETA must never be presented as authoritative routing when it
 * is not.
 */
export const ROUTE_TTL_S = 300; // §Phase 3 deliverable: 5-minute TTL
export const GEOCODE_TTL_S = 86_400; // 24 h
const OSRM_TIMEOUT_MS = 1_500; // > p95 uncached budget 800 ms, < request stall
const NOMINATIM_TIMEOUT_MS = 2_500;
async function fetchWithTimeout(url, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, {
            signal: ctrl.signal,
            headers: { 'user-agent': env.OSM_USER_AGENT }, // §1.6 UA compliance (applies even self-hosted)
        });
    }
    finally {
        clearTimeout(t);
    }
}
function straightLineFallback(from, to) {
    const distance = haversineM(from.lat, from.lng, to.lat, to.lng);
    // 30 km/h urban average — deliberately conservative; flagged in `source`.
    return {
        from, to,
        distance_m: Math.round(distance),
        duration_s: Math.round(distance / 8.33),
        geometry: [[from.lat, from.lng], [to.lat, to.lng]],
        source: 'fallback_straight',
        cached_at: new Date().toISOString(),
    };
}
/** Postgres companion-cache read (survives Redis eviction/restart). §1.5 "Owns: route_cache". */
async function pgRouteLookup(key, allowExpired = false) {
    try {
        const { rows } = await pool.query(`SELECT from_lat, from_lng, to_lat, to_lng, distance_m, duration_s,
              geometry_json, osrm_source, created_at
         FROM route_cache WHERE cache_key = $1
           ${allowExpired ? '' : 'AND expires_at > now()'}
         ORDER BY created_at DESC LIMIT 1`, [key]);
        const r = rows[0];
        if (!r)
            return null;
        return {
            from: { lat: r.from_lat, lng: r.from_lng },
            to: { lat: r.to_lat, lng: r.to_lng },
            distance_m: Number(r.distance_m),
            duration_s: Number(r.duration_s),
            geometry: r.geometry_json,
            source: 'postgres',
            cached_at: new Date(r.created_at).toISOString(),
        };
    }
    catch {
        return null; // DB hiccup on a cache read must not fail the request path
    }
}
async function pgRouteUpsert(key, res) {
    try {
        await pool.query(`INSERT INTO route_cache (cache_key, from_lat, from_lng, to_lat, to_lng, profile,
                                distance_m, duration_s, geometry_json, osrm_source, expires_at)
       VALUES ($1,$2,$3,$4,$5,'driving',$6,$7,$8::jsonb,$9, now() + ($10 || ' seconds')::interval)
       ON CONFLICT (cache_key) DO UPDATE SET
         distance_m = EXCLUDED.distance_m, duration_s = EXCLUDED.duration_s,
         geometry_json = EXCLUDED.geometry_json, osrm_source = EXCLUDED.osrm_source,
         created_at = now(), expires_at = EXCLUDED.expires_at`, [key, res.from.lat, res.from.lng, res.to.lat, res.to.lng,
            res.distance_m, res.duration_s, JSON.stringify(res.geometry), res.source, String(ROUTE_TTL_S)]);
    }
    catch (err) {
        console.warn('[osm-gateway] route_cache upsert failed:', String(err));
    }
}
/**
 * Route between two points via self-hosted OSRM with Redis-first caching.
 * `allowStale=true` (used by the ETA panel's poll loop) accepts an expired Redis
 * value when OSRM is down — a slightly old route beats no route during a pilot.
 */
export async function getRoute(from, to, opts = {}) {
    const key = routeCacheKey(from, to);
    // 1) Fresh Redis hit — target ≤ 50 ms (§1.9.4).
    const fresh = await cacheGetJson(key);
    if (fresh)
        return { ...fresh, source: 'redis' };
    // 2) Unexpired Postgres row (warm start after Redis flush).
    const pg = await pgRouteLookup(key);
    if (pg) {
        void cacheSetJson(key, pg, ROUTE_TTL_S);
        return pg;
    }
    // 3) Live OSRM call.
    try {
        const url = `${env.OSRM_BASE_URL}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}`
            + `?overview=full&geometries=polyline`;
        const res = await fetchWithTimeout(url, OSRM_TIMEOUT_MS);
        if (!res.ok)
            throw new Error(`OSRM ${res.status}`);
        const body = await res.json();
        if (body.code !== 'Ok' || !body.routes?.length)
            throw new Error(`OSRM ${body.code}`);
        const r = body.routes[0];
        const out = {
            from, to,
            distance_m: Math.round(r.distance),
            duration_s: Math.round(r.duration),
            geometry: decodePolyline(r.geometry),
            source: 'osrm',
            cached_at: new Date().toISOString(),
        };
        await cacheSetJson(key, out, ROUTE_TTL_S);
        void pgRouteUpsert(key, out);
        return out;
    }
    catch (err) {
        // 4) Degradation ladder: expired-but-recent Postgres row, then honest
        //    straight-line fallback (labeled so the dashboard never claims routing).
        console.warn('[osm-gateway] OSRM unavailable:', String(err));
        if (opts.allowStale) {
            const stale = await pgRouteLookup(key, true);
            if (stale)
                return stale;
        }
        const fb = straightLineFallback(from, to);
        // Cache the fallback briefly so a flapping OSRM doesn't multiply load.
        await cacheSetJson(key, fb, 30);
        return fb;
    }
}
/**
 * Forward geocode via self-hosted Nominatim, Redis-cached 24 h.
 * Ethiopia-biased (viewbox + countrycodes=et) so "Bole" resolves in Addis, not Brazil.
 */
export async function geocode(q, lang) {
    const key = geocodeCacheKey(q, lang);
    const hit = await cacheGetJson(key);
    if (hit)
        return hit;
    const params = new URLSearchParams({
        q, format: 'jsonv2', limit: '5', 'countrycodes': 'et',
        addressdetails: '0', 'accept-language': lang ?? 'en,am',
    });
    try {
        const res = await fetchWithTimeout(`${env.NOMINATIM_BASE_URL}/search?${params.toString()}`, NOMINATIM_TIMEOUT_MS);
        if (!res.ok)
            throw new Error(`Nominatim ${res.status}`);
        const rows = await res.json();
        const out = rows.map((r) => ({
            ...r,
            lat: roundCoord(Number(r.lat)),
            lon: roundCoord(Number(r.lon)),
        }));
        await cacheSetJson(key, out, GEOCODE_TTL_S);
        return out;
    }
    catch (err) {
        console.warn('[osm-gateway] Nominatim unavailable:', String(err));
        return [];
    }
}
//# sourceMappingURL=service.js.map