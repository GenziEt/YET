import { env } from '../../config/env.js';
import { cacheGetJson, cacheSetJson, cacheKeysByPrefix, cacheDelMany } from '../../lib/redis.js';
import { pool } from '../../db/pool.js';
import { haversineM } from '../trip_engine/state_machine.js';
import {
  decodePolyline, routeCacheKey, geocodeCacheKey, roundCoord, type LatLng,
} from './geo.js';

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

export const ROUTE_TTL_S = 300;      // §Phase 3 deliverable: 5-minute TTL
export const GEOCODE_TTL_S = 86_400; // 24 h
const OSRM_TIMEOUT_MS = 1_500;       // > p95 uncached budget 800 ms, < request stall
const NOMINATIM_TIMEOUT_MS = 2_500;

/* --------------------------- fetch seam (testing) ---------------------------- */
/** Injectable transport so the retry/degradation ladder is unit-testable without
 *  a live OSRM/Nominatim container. Production bootstrap never touches this —
 *  default is global fetch. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> })
  => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let fetchImpl: FetchLike = ((url, init) => fetch(url, init)) as FetchLike;
export function setFetchForTesting(fn: FetchLike | null): void {
  fetchImpl = fn ?? ((url, init) => fetch(url, init)) as FetchLike;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': env.OSM_USER_AGENT }, // §1.6 UA compliance (applies even self-hosted)
    }) as unknown as Response;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Bounded-retry wrapper for the OSRM leg (Phase 3: "failures, timeouts, and
 * retries are handled"). Policy:
 *   - RETRY ONLY network aborts: fetch rejects before any HTTP response exists
 *     (connection refused, DNS failure, AbortController timeout). These are
 *     transient container/network blips during a pilot.
 *   - NEVER retry an HTTP response — even 4xx/5xx with a body. A routing-engine
 *     error is deterministic per input; hammering it wastes the ≤800 ms budget.
 *     Such responses throw RoutingHttpError, which skips the retry loop entirely.
 *   - Backoff between attempts: OSRM_RETRY_BACKOFF_MS (default 120 ms), capped
 *     total by OSRM_RETRY_ATTEMPTS (default 1 retry, max 3 via env validation).
 */
class RoutingHttpError extends Error {}

async function fetchOsrmWithRetry(url: string): Promise<Response> {
  const maxRetries = env.OSRM_RETRY_ATTEMPTS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && env.OSRM_RETRY_BACKOFF_MS > 0) {
      await new Promise((r) => setTimeout(r, env.OSRM_RETRY_BACKOFF_MS));
    }
    try {
      const res = await fetchWithTimeout(url, OSRM_TIMEOUT_MS);
      // An HTTP response exists ⇒ never retried (deterministic per input; a 5xx
      // from the routing engine must descend the degradation ladder immediately).
      if (!res.ok) throw new RoutingHttpError(`OSRM ${res.status}`);
      return res;
    } catch (err) {
      if (err instanceof RoutingHttpError) throw err; // deterministic: fail to ladder now
      lastErr = err; // network abort (incl. timeout) → bounded retry
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface RouteResult {
  from: LatLng;
  to: LatLng;
  distance_m: number;
  duration_s: number;
  geometry: [number, number][]; // decoded polyline [lat,lng][]
  source: 'redis' | 'postgres' | 'osrm' | 'stale_redis' | 'fallback_straight';
  cached_at: string;            // event-time-ish provenance for the dashboard badge
}

function straightLineFallback(from: LatLng, to: LatLng): RouteResult {
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
async function pgRouteLookup(key: string, allowExpired = false): Promise<RouteResult | null> {
  try {
    const { rows } = await pool.query(
      `SELECT from_lat, from_lng, to_lat, to_lng, distance_m, duration_s,
              geometry_json, osrm_source, created_at
         FROM route_cache WHERE cache_key = $1
           ${allowExpired ? '' : 'AND expires_at > now()'}
         ORDER BY created_at DESC LIMIT 1`,
      [key]);
    const r = rows[0];
    if (!r) return null;
    return {
      from: { lat: r.from_lat, lng: r.from_lng },
      to: { lat: r.to_lat, lng: r.to_lng },
      distance_m: Number(r.distance_m),
      duration_s: Number(r.duration_s),
      geometry: r.geometry_json as [number, number][],
      source: 'postgres',
      cached_at: new Date(r.created_at).toISOString(),
    };
  } catch {
    return null; // DB hiccup on a cache read must not fail the request path
  }
}

async function pgRouteUpsert(key: string, res: RouteResult): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO route_cache (cache_key, from_lat, from_lng, to_lat, to_lng, profile,
                                distance_m, duration_s, geometry_json, osrm_source, expires_at)
       VALUES ($1,$2,$3,$4,$5,'driving',$6,$7,$8::jsonb,$9, now() + ($10 || ' seconds')::interval)
       ON CONFLICT (cache_key) DO UPDATE SET
         distance_m = EXCLUDED.distance_m, duration_s = EXCLUDED.duration_s,
         geometry_json = EXCLUDED.geometry_json, osrm_source = EXCLUDED.osrm_source,
         created_at = now(), expires_at = EXCLUDED.expires_at`,
      [key, res.from.lat, res.from.lng, res.to.lat, res.to.lng,
       res.distance_m, res.duration_s, JSON.stringify(res.geometry), res.source, String(ROUTE_TTL_S)],
    );
  } catch (err) {
    console.warn('[osm-gateway] route_cache upsert failed:', String(err));
  }
}

/**
 * Route between two points via self-hosted OSRM with Redis-first caching.
 * `allowStale=true` (used by the ETA panel's poll loop) accepts an expired Redis
 * value when OSRM is down — a slightly old route beats no route during a pilot.
 * `destinationGeofenceId` (set by GET /route?destination_geofence_id=…) records
 * a write-through index key so a later geofence edit can invalidate exactly the
 * route entries whose destination centroid came from that zone (§Phase 3
 * invalidation rules — see invalidateRoutesForGeofence).
 */
export async function getRoute(
  from: LatLng, to: LatLng,
  opts: { allowStale?: boolean; destinationGeofenceId?: string } = {},
): Promise<RouteResult> {
  const key = routeCacheKey(from, to);

  // 1) Fresh Redis hit — target ≤ 50 ms (§1.9.4).
  const fresh = await cacheGetJson<RouteResult>(key);
  if (fresh) return { ...fresh, source: 'redis' };

  // 2) Unexpired Postgres row (warm start after Redis flush).
  const pg = await pgRouteLookup(key);
  if (pg) { void cacheSetJson(key, pg, ROUTE_TTL_S); void indexDest(key, opts); return pg; }

  // 3) Live OSRM call (bounded retry on network aborts only — fetchOsrmWithRetry).
  try {
    const url = `${env.OSRM_BASE_URL}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}`
      + `?overview=full&geometries=polyline`;
    const res = await fetchOsrmWithRetry(url);
    const body = await res.json() as {
      code: string;
      routes?: { distance: number; duration: number; geometry: string }[];
    };
    if (body.code !== 'Ok' || !body.routes?.length) throw new RoutingHttpError(`OSRM ${body.code}`);
    const r = body.routes[0]!;
    const out: RouteResult = {
      from, to,
      distance_m: Math.round(r.distance),
      duration_s: Math.round(r.duration),
      geometry: decodePolyline(r.geometry),
      source: 'osrm',
      cached_at: new Date().toISOString(),
    };
    await cacheSetJson(key, out, ROUTE_TTL_S);
    void indexDest(key, opts);
    void pgRouteUpsert(key, out);
    return out;
  } catch (err) {
    // 4) Degradation ladder: expired-but-recent Postgres row, then honest
    //    straight-line fallback (labeled so the dashboard never claims routing).
    console.warn('[osm-gateway] OSRM unavailable:', String(err));
    if (opts.allowStale) {
      const stale = await pgRouteLookup(key, true);
      if (stale) return stale;
    }
    const fb = straightLineFallback(from, to);
    // Cache the fallback briefly so a flapping OSRM doesn't multiply load.
    await cacheSetJson(key, fb, 30);
    void indexDest(key, opts);
    return fb;
  }
}

/* --------------------- Geofence-keyed invalidation index --------------------- */
/** Redis index key for "route keys computed against this destination geofence".
 *  Written on every getRoute write-through when the caller supplied the zone id
 *  (the dashboard's select-geofence-as-destination flow). */
export function destIndexKey(geofenceId: string): string {
  return `yet:route:dest:${geofenceId}`;
}

async function indexDest(routeKey: string, opts: { destinationGeofenceId?: string }): Promise<void> {
  if (!opts.destinationGeofenceId) return;
  const idx = destIndexKey(opts.destinationGeofenceId);
  try {
    const members = await cacheGetJson<string[]>(idx);
    const set = new Set(members ?? []);
    set.add(routeKey);
    // Index TTL ≥ route TTL so it always outlives the entries it references.
    await cacheSetJson(idx, [...set], ROUTE_TTL_S + 60);
  } catch { /* best-effort: worst case the entry expires by TTL */ }
}

/**
 * Phase 3 cache-invalidation rule: when a geofence is edited (renamed, moved,
 * resized) or deactivated, every route/ETA cached against its centroid must be
 * dropped — a renamed/moved warehouse can never serve an ETA to stale geometry.
 *   - deletes the Redis route entries listed in yet:route:dest:<id>,
 *   - removes the dependent fleet-state snapshot so live-map badges rebuild,
 *   - expires the matching Postgres route_cache rows (version bump = created_at
 *     moves and expires_at collapses to now(); warm-start reads require
 *     expires_at > now(), so the rows are superseded rather than deleted —
 *     audit trail of routing calls preserved, §1.5).
 * Called from updateGeofence/deleteGeofence AFTER the row change commits.
 */
export async function invalidateRoutesForGeofence(geofenceId: string): Promise<void> {
  const idx = destIndexKey(geofenceId);
  const members = await cacheGetJson<string[]>(idx).catch(() => null);
  if (members && members.length > 0) await cacheDelMany(members);
  await cacheDelMany([idx]);
  // Fleet-state snapshots embed last-known route badges; force one-query refresh.
  const fleetKeys = await cacheKeysByPrefix('fleet:state');
  await cacheDelMany(fleetKeys);
  try {
    await pool.query(
      `UPDATE route_cache SET expires_at = now(), created_at = now()
        WHERE expires_at > now()
          AND round(to_lat::numeric, 6) = round((SELECT center_lat FROM geofences WHERE geofence_id=$1)::numeric, 6)
          AND round(to_lng::numeric, 6) = round((SELECT center_lng FROM geofences WHERE geofence_id=$1)::numeric, 6)`,
      [geofenceId],
    );
  } catch (err) {
    // DB hiccup on invalidation must not fail the geofence mutation — Redis
    // entries are already gone and the rows expire within ROUTE_TTL_S anyway.
    console.warn('[osm-gateway] route_cache expiry bump failed:', String(err));
  }
}

/* ------------------------------ Geocoding ---------------------------------- */

export interface GeocodeHit {
  place_id?: number;
  lat: number;
  lon: number;
  display_name: string;
  class?: string;
  type?: string;
  importance?: number;
}

/**
 * Forward geocode via self-hosted Nominatim, Redis-cached 24 h.
 * Ethiopia-biased (viewbox + countrycodes=et) so "Bole" resolves in Addis, not Brazil.
 */
export async function geocode(q: string, lang?: string): Promise<GeocodeHit[]> {
  const key = geocodeCacheKey(q, lang);
  const hit = await cacheGetJson<GeocodeHit[]>(key);
  if (hit) return hit;

  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: '5', 'countrycodes': 'et',
    addressdetails: '0', 'accept-language': lang ?? 'en,am',
  });
  try {
    const res = await fetchWithTimeout(`${env.NOMINATIM_BASE_URL}/search?${params.toString()}`, NOMINATIM_TIMEOUT_MS);
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const rows = await res.json() as GeocodeHit[];
    const out = rows.map((r) => ({
      ...r,
      lat: roundCoord(Number(r.lat)),
      lon: roundCoord(Number(r.lon)),
    }));
    await cacheSetJson(key, out, GEOCODE_TTL_S);
    return out;
  } catch (err) {
    console.warn('[osm-gateway] Nominatim unavailable:', String(err));
    return [];
  }
}
