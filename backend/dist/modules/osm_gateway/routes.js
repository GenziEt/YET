import { z } from 'zod';
import { verifyAccessToken } from '../../lib/jwt.js';
import { getRoute, geocode } from './service.js';
import { parseLatLng, computeEta } from './geo.js';
import { pool } from '../../db/pool.js';
/**
 * Module 7 — OSM Gateway HTTP surface (Phase 3).
 *   GET /route?from=lat,lng&to=lat,lng     → OSRM geometry + duration (+ETA when
 *                                            ?vehicle_id= given), Redis-cached 5 min.
 *   GET /geocode?q=address                  → self-hosted Nominatim, Redis-cached 24 h.
 *
 * API budgets (§1.9.4): cached route ≤ 50 ms p95 (Redis hit path is a single GET);
 * uncached ≤ 800 ms (OSRM timeout capped at 1.5 s so a dead container degrades
 * fast instead of stalling the dashboard).
 */
async function auth(req) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    return verifyAccessToken(header.slice(7));
}
/** Latest fix + trip state for a vehicle — feeds the speed-adjusted ETA (§Phase 3). */
async function vehicleLiveSnapshot(vehicleId) {
    const { rows: fixRows } = await pool.query(`SELECT speed_mps, fix_timestamp FROM location_fixes
      WHERE vehicle_id=$1 ORDER BY fix_timestamp DESC LIMIT 1`, [vehicleId]);
    const { rows: tripRows } = await pool.query(`SELECT state, stop_at FROM trips WHERE vehicle_id=$1 AND ended_at IS NULL
      ORDER BY started_at DESC LIMIT 1`, [vehicleId]);
    const lastFix = fixRows[0];
    const trip = tripRows[0];
    const stopped = trip?.state === 'STOPPED';
    return {
        osrmDurationS: 0, // filled by caller
        distanceM: 0, // filled by caller
        vehicleSpeedMps: lastFix ? (lastFix.speed_mps ?? 0) : null,
        stoppedSinceMs: stopped && trip?.stop_at ? new Date(trip.stop_at).getTime() : null,
        state: trip?.state ?? null,
    };
}
export default async function osmRoutes(app) {
    /**
     * GET /route?from=9.03,38.74&to=8.98,38.79[&vehicle_id=UUID]
     * When vehicle_id is supplied the response embeds an ETA computed from the
     * vehicle's current speed and trip state, plus the staleness caveat required
     * by the Phase 3 deliverable ("If the vehicle is in STOPPED state, ETA is
     * marked 'stale' and the timestamp of last movement is shown").
     */
    app.get('/route', async (req, reply) => {
        const claims = await auth(req);
        const parsed = z.object({
            from: z.string(),
            to: z.string(),
            vehicle_id: z.string().uuid().optional(),
            destination_geofence_id: z.string().uuid().optional(),
        }).safeParse(req.query);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
        let from;
        let to;
        try {
            from = parseLatLng(parsed.data.from);
            to = parseLatLng(parsed.data.to);
        }
        catch (e) {
            return reply.code(400).send({ error: 'invalid_coordinate', detail: String(e.message) });
        }
        // Destination may be given as a geofence id (dashboard "select geofence as
        // destination" flow) — resolve its center/centroid server-side.
        if (parsed.data.destination_geofence_id) {
            const { rows: cen } = await pool.query(`SELECT ST_Y(c) AS lat, ST_X(c) AS lng FROM (
           SELECT CASE WHEN kind='CIRCLE' THEN geom::geometry
                       ELSE ST_Centroid(geom)::geometry END AS c
             FROM geofences WHERE geofence_id=$1 AND active) s`, [parsed.data.destination_geofence_id]);
            if (!cen[0])
                return reply.code(404).send({ error: 'geofence_not_found' });
            to = { lat: Math.round(Number(cen[0].lat) * 1e6) / 1e6, lng: Math.round(Number(cen[0].lng) * 1e6) / 1e6 };
        }
        const route = await getRoute(from, to, { allowStale: true });
        let eta = null;
        if (parsed.data.vehicle_id) {
            if (claims.role === 'DRIVER' && parsed.data.vehicle_id) {
                // Drivers may only route relative to their own assigned vehicle (§1.7 minimization).
                const { rows } = await pool.query(`SELECT vehicle_id FROM driver_vehicle_assignments
            WHERE driver_id=$1 AND unassigned_at IS NULL LIMIT 1`, [claims.sub]);
                if (rows[0]?.vehicle_id !== parsed.data.vehicle_id)
                    return reply.code(403).send({ error: 'forbidden_role' });
            }
            const snap = await vehicleLiveSnapshot(parsed.data.vehicle_id);
            const computed = computeEta({ ...snap, osrmDurationS: route.duration_s, distanceM: route.distance_m }, Date.now());
            eta = { ...computed, state: snap.state };
        }
        return {
            from, to,
            distance_m: route.distance_m,
            duration_s: route.duration_s,
            geometry: route.geometry, // [[lat,lng],...] ready for Leaflet Polyline
            source: route.source, // redis|postgres|osrm|fallback_straight
            cached_at: route.cached_at,
            fallback: route.source === 'fallback_straight', // honest label for straight-line ETA
            eta,
        };
    });
    /** GET /geocode?q=Bole%20Airport[&lang=am] — Nominatim proxy with Redis cache. */
    app.get('/geocode', async (req, reply) => {
        await auth(req);
        const parsed = z.object({ q: z.string().min(2).max(200), lang: z.enum(['en', 'am']).optional() })
            .safeParse(req.query);
        if (!parsed.success)
            return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
        const hits = await geocode(parsed.data.q, parsed.data.lang);
        return { query: parsed.data.q, count: hits.length, results: hits };
    });
}
//# sourceMappingURL=routes.js.map