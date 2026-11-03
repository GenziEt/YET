/**
 * Module 6 — Reporting: read-side service (Phase 5, B).
 *
 * Scaling guardrail (§1.10.3): "Reporting reads from a Postgres read replica,
 * never the primary." Every query here goes through db/replica.ts `readQuery()`
 * — which enforces BEGIN READ ONLY on a real replica and falls back to the
 * primary pool in dev (zero-config pilots). Replica lag is surfaced so the
 * dashboard can show an honest staleness banner (§1.8.4).
 *
 * Data minimization (§1.7): reports aggregate trip-level facts; raw fixes are
 * never returned. The fleet-state cache exists so N polling dashboards cost ONE
 * aggregate query per 30s window (§1.10.2), not N per second.
 */
import { readQuery, replicaLagSeconds } from '../../db/replica.js';
import { cacheGetJson, cacheSetJson } from '../../lib/redis.js';
import { bucketTripsByWeek, summarizeTrips, buildFleetOverview, FLEET_STATE_CACHE_KEY, FLEET_STATE_TTL_S, FLEET_LIVE_WINDOW_S, } from './kernel.js';
/**
 * GET /reports/trips — weekly trip report (§Master: "export a weekly trip
 * report"). Trips + per-week buckets + totals, ordered by EVENT time. p95
 * budget ≤500ms for one week/one driver (§1.9.4) — idx_trips_driver_time covers
 * the filter, aggregation happens over at most a few hundred rows.
 */
export async function getTripReport(q) {
    const params = [q.from, q.to];
    let where = `t.started_at >= $1 AND t.started_at < $2`;
    if (q.driver_id) {
        params.push(q.driver_id);
        where += ` AND t.driver_id = $${params.length}`;
    }
    // Phase 0 tenant scoping: FLEET_MANAGER reads confined to their fleet's drivers.
    if (q.fleet_id) {
        params.push(q.fleet_id);
        where += ` AND u.fleet_id = $${params.length}`;
    }
    const trips = await readQuery(`SELECT t.trip_id,
            t.driver_id,
            v.plate_number,
            to_char(t.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
            to_char(t.ended_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_at,
            t.state::text AS state,
            t.distance_m, t.moving_duration_s, t.stopped_duration_s,
            t.turn_count, t.harsh_event_count
       FROM trips t
       LEFT JOIN vehicles v ON v.id = t.vehicle_id
       LEFT JOIN users u    ON u.id = t.driver_id
      WHERE ${where}
      ORDER BY t.started_at ASC
      LIMIT 5000`, params);
    return {
        window: { from: q.from, to: q.to },
        driver_id: q.driver_id ?? null,
        summary: summarizeTrips(trips),
        weeks: bucketTripsByWeek(trips),
        trips,
    };
}
/**
 * GET /reports/separations — driver-left-vehicle incidents (§1.4) with the
 * truck's LAST KNOWN position labeled honestly (never presented as live), plus
 * whether the fleet manager was notified and how long separation lasted.
 */
export async function getSeparationIncidents(q) {
    const params = [q.from, q.to];
    let where = `s.separated_at >= $1 AND s.separated_at < $2`;
    if (q.driver_id) {
        params.push(q.driver_id);
        where += ` AND s.driver_id = $${params.length}`;
    }
    // Phase 0 tenant scoping: FLEET_MANAGER reads confined to their fleet's drivers.
    if (q.fleet_id) {
        params.push(q.fleet_id);
        where += ` AND u.fleet_id = $${params.length}`;
    }
    if (q.open_only)
        where += ` AND s.returned_at IS NULL`;
    const rows = await readQuery(`SELECT s.separation_id, s.trip_id, s.vehicle_id, s.driver_id,
            u.full_name AS driver_name, v.plate_number,
            s.status::text AS status,
            to_char(s.separated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS separated_at,
            to_char(s.returned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS returned_at,
            CASE WHEN s.returned_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (s.returned_at - s.separated_at)) / 60
            END AS duration_min,
            s.truck_stop_lat, s.truck_stop_lng,
            s.distance_m, s.notified_fleet_manager
       FROM driver_separation_log s
       LEFT JOIN users u    ON u.id = s.driver_id
       LEFT JOIN vehicles v ON v.id = s.vehicle_id
      WHERE ${where}
      ORDER BY s.separated_at DESC
      LIMIT 2000`, params);
    return {
        window: { from: q.from, to: q.to },
        driver_id: q.driver_id ?? null,
        count: rows.length,
        incidents: rows.map((r) => ({
            ...r,
            // §1.4 honesty rule baked into the payload shape: this is a snapshot of
            // where the TRUCK was when separation began — the truck does not phone home.
            truck_last_known_location: { lat: r.truck_stop_lat, lng: r.truck_stop_lng, label: 'last_known' },
        })),
    };
}
/**
 * GET /reports/fleet-state — live map feed. Redis-cached under fleet:state with
 * TTL 30s: the FIRST request after expiry pays the aggregate query, every
 * subsequent poll within the window is served from cache (dashboards ×N stop
 * multiplying DB load, §1.10.2). Annotated with replica_lag_s so the UI can say
 * "data may be Xs behind" instead of pretending freshness (§1.8.4).
 */
export async function getFleetOverview(opts) {
    // Phase 0 tenant scoping: fleet-scoped overviews cache under their own key so a
    // FLEET_MANAGER can never be served another fleet's cached aggregate (and the
    // SQL below filters to their fleet). ADMIN/undefined ⇒ whole-platform view.
    const cacheKey = opts?.fleetId ? `${FLEET_STATE_CACHE_KEY}:${opts.fleetId}` : FLEET_STATE_CACHE_KEY;
    const hit = await cacheGetJson(cacheKey);
    if (hit?.result) {
        return { ...hit.result, cached: true, replica_lag_s: await replicaLagSeconds(), live_window_s: FLEET_LIVE_WINDOW_S };
    }
    // Latest fix per vehicle inside a bounded recent horizon — DISTINCT ON over the
    // (vehicle_id, fix_timestamp) index scan; the horizon keeps it partition-pruned.
    const fixes = await readQuery(`SELECT DISTINCT ON (lf.vehicle_id)
            lf.vehicle_id, v.plate_number, lf.driver_id, u.full_name AS driver_name,
            to_char(lf.fix_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fix_timestamp,
            lf.lat, lf.lng, lf.speed_mps, lf.accuracy_m
       FROM location_fixes lf
       LEFT JOIN vehicles v ON v.id = lf.vehicle_id
       LEFT JOIN users u    ON u.id = lf.driver_id
      WHERE lf.fix_timestamp > now() - INTERVAL '24 hours'
        AND ($1::uuid IS NULL OR u.fleet_id = $1)
      ORDER BY lf.vehicle_id, lf.fix_timestamp DESC`, [opts?.fleetId ?? null]);
    const statuses = await readQuery(`SELECT t.vehicle_id, t.trip_id, t.driver_id, t.state::text AS state,
            to_char(t.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
            to_char(t.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_activity_at,
            (ds.separation_id IS NOT NULL) AS separation_open,
            CASE WHEN ds.separated_at IS NOT NULL
                 THEN ROUND(EXTRACT(EPOCH FROM (now() - ds.separated_at)) / 60)::int
            END AS separated_minutes,
            COALESCE(ds.notified_fleet_manager, false) AS notified
       FROM trips t
       LEFT JOIN LATERAL (
         SELECT s.separation_id, s.separated_at, s.notified_fleet_manager
           FROM driver_separation_log s
          WHERE s.trip_id = t.trip_id AND s.returned_at IS NULL
          ORDER BY s.separated_at DESC LIMIT 1
       ) ds ON true
       LEFT JOIN users du ON du.id = t.driver_id
      WHERE t.ended_at IS NULL
        AND ($1::uuid IS NULL OR du.fleet_id = $1)`, [opts?.fleetId ?? null]);
    const nowMs = Date.now();
    const result = buildFleetOverview({ fixes, statuses, nowMs, liveWindowS: FLEET_LIVE_WINDOW_S });
    await cacheSetJson(cacheKey, { result }, FLEET_STATE_TTL_S);
    return { ...result, cached: false, replica_lag_s: await replicaLagSeconds(), live_window_s: FLEET_LIVE_WINDOW_S };
}
//# sourceMappingURL=service.js.map