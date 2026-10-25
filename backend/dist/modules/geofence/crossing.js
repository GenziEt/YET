/**
 * Module 4 — Geofence & Route: crossing evaluator (Phase 3).
 *
 * Registered into the existing ingest → trip-engine seam at the composition root
 * (app.ts) so Ingest stays trip-logic-free (§1.5): the hook fires after each
 * accepted location batch, on the SAME event-time window Trip Engine recomputes.
 *
 * Contract (§1.8.3):
 *  - Event-time based: statuses are derived from fix timestamps, never arrival
 *    order. A late/offline replay re-evaluates the affected window and upserts
 *    events by the identical key (trip_id, event_type, event_timestamp), so a
 *    GEOFENCE_ENTER for a given moment is emitted EXACTLY once no matter how many
 *    times or in what order the underlying batches arrive.
 *  - Idempotent upsert with DO UPDATE keeps payload fresh (e.g. geofence renamed
 *    between replays) without ever duplicating rows (unique index uq_trip_event).
 *  - Deterministic candidate ordering (geofence_id ASC) means concurrent windows
 *    can never interleave differently-shaped writes for the same key.
 */
import { pool } from '../../db/pool.js';
const MAX_CANDIDATE_GEOFENCES = 200; // sane cap; Addis warehouse density ≪ this
/**
 * Candidate geofences near a set of fixes, via the GiST index (migration 0009):
 * ST_DWithin on the geometry PLANE with a degree cap (~2.8 km max circle) keeps
 * the lookup index-bounded; circles get the exact geography test per fix below.
 */
async function candidateGeofences(fixes, fleetId) {
    if (fixes.length === 0)
        return [];
    const lats = fixes.map((f) => f.lat);
    const lngs = fixes.map((f) => f.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const { rows } = await pool.query(
    // NOTE: every ST_MakeEnvelope argument is explicitly ::double precision.
    // Without the casts Postgres cannot infer $1's type (it appears only inside
    // a function taking polymorphic/overloaded args) and errors with
    // "could not determine data type of parameter $1" — first live-stack run.
    `SELECT g.geofence_id, g.name, g.kind, g.category, g.radius_m,
            ST_AsText(g.geom) AS geom_wkt
       FROM geofences g
      WHERE g.active
        AND ($5::uuid IS NULL OR g.fleet_id = $5)
        AND ST_Intersects(g.geom, ST_MakeEnvelope($1::double precision,$2::double precision,$3::double precision,$4::double precision,4326))
      ORDER BY g.geofence_id
      LIMIT ${MAX_CANDIDATE_GEOFENCES}`, [minLng - 0.05, minLat - 0.05, maxLng + 0.05, maxLat + 0.05, fleetId ?? null]);
    return rows;
}
/** Parse "POINT(lng lat)" / "MULTIPOLYGON(((lng lat,...)))" from ST_AsText. */
export function parseWktPoint(wkt) {
    const m = /^POINT\s*\(\s*([-0-9.eE]+)\s+([-0-9.eE]+)\s*\)$/i.exec(wkt.trim());
    if (!m)
        return null;
    return { lng: Number(m[1]), lat: Number(m[2]) };
}
export function parseWktPolygonRings(wkt) {
    const inner = wkt.slice(wkt.indexOf('(((') + 3, wkt.lastIndexOf(')))'));
    if (!inner)
        return [];
    return inner.split('),(').map((ring) => ring.split(',').map((pair) => pair.trim().split(/\s+/).map(Number)));
}
/** Ray-casting point-in-polygon on the lng/lat plane (candidate count is tiny;
 *  PostGIS remains the authority inside SQL — this JS path mirrors it exactly for
 *  debugging/UI previews). NOTE: not used by evaluateCrossings, which computes the
 *  authoritative status matrix in a single PostGIS round-trip. */
export function pointInRing(lat, lng, ring) {
    let inside = false;
    // Strict crossing test with half-open edge rule ((yi > y) !== (yj > y)) — the
    // naive form misclassifies points whose ordinate equals a vertex ordinate.
    const x = lng, y = lat;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j]; // [lng,lat] pairs
        const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersect)
            inside = !inside;
    }
    return inside;
}
/**
 * Evaluate inside/outside status of every fix against every candidate geofence in
 * ONE SQL round-trip (status matrix), then diff consecutive fixes per geofence to
 * derive ENTER/EXIT transitions. Consecutive here means consecutive IN TIME across
 * the whole stored history of the vehicle — the query loads prev_fix explicitly,
 * so a crossing detected at the window's leading edge still diffs correctly.
 */
export async function evaluateCrossings(vehicleId, driverId, fromMs, toMs) {
    // Trips overlapping the window (open trips included — their started_at may be
    // before `from`, we clamp the fix scan to the window itself).
    const { rows: tripRows } = await pool.query(`SELECT trip_id, started_at, ended_at FROM trips
      WHERE vehicle_id=$1
        AND started_at <= $3
        AND (ended_at IS NULL OR ended_at >= $2)
      ORDER BY started_at ASC`, [vehicleId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()]);
    if (tripRows.length === 0)
        return [];
    // Gather all fixes in the window plus the one immediately preceding it (the
    // "previous status" anchor for boundary crossings at the window start).
    const { rows: fixRows } = await pool.query(`SELECT fix_timestamp, lat, lng FROM location_fixes
      WHERE vehicle_id=$1 AND fix_timestamp >= $2 AND fix_timestamp <= $3
      UNION ALL
      (SELECT fix_timestamp, lat, lng FROM location_fixes
        WHERE vehicle_id=$1 AND fix_timestamp < $2
        ORDER BY fix_timestamp DESC LIMIT 1)
      ORDER BY fix_timestamp ASC`, [vehicleId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()]);
    const fixes = fixRows.map((r) => ({
        t: new Date(r.fix_timestamp).getTime(), lat: Number(r.lat), lng: Number(r.lng),
    }));
    if (fixes.length < 2)
        return [];
    // Tenant filter (Phase 0): a vehicle's crossings only consider zones owned by
    // ITS fleet — cross-fleet geometry must never fire ENTER/EXIT events for
    // another tenant. NULL fleet (legacy/unassigned vehicles) keeps global scope.
    const { rows: vrow } = await pool.query(`SELECT fleet_id FROM vehicles WHERE id=$1`, [vehicleId]);
    const fences = await candidateGeofences(fixes, vrow[0]?.fleet_id ?? null);
    if (fences.length === 0)
        return [];
    // Status matrix: one row per (fix, fence) computed in Postgres so the geometry
    // authority stays in PostGIS (circle ⇒ ST_DWithin on geography; polygon ⇒
    // ST_Intersects). We pass fixes as arrays to keep it a single round-trip.
    // NOTE (live-stack watch items, both confirmed against the running stack):
    //  - Parameters must be $1..$3 with NO unused placeholder. A null first
    //    element makes Postgres report "could not determine data type of
    //    parameter $1" even though every referenced param carries an explicit
    //    cast — unreferenced params cannot be typed.
    //  - Use multi-arg unnest(...) WITH ORDINALITY instead of three parallel
    //    set-returning functions (generate_subscripts + two unnests); the
    //    WITH ORDINALITY form guarantees row alignment by construction.
    //  - The join order below is load-bearing — geofences drives the outer loop
    //    (GiST-friendly per-fence point tests), fixes is the cross-joined side;
    //    swapping them changes plan shape and can silently drop rows if the CTE
    //    ordering assumptions are edited later.
    const lats = fixes.map((f) => f.lat);
    const lngs = fixes.map((f) => f.lng);
    const fenceIds = fences.map((f) => f.geofence_id);
    const { rows: matrix } = await pool.query(`WITH fixes AS (
       SELECT t.idx, t.lat, t.lng
         FROM unnest($1::double precision[], $2::double precision[])
              WITH ORDINALITY AS t(lat, lng, idx)
     )
     SELECT fx.idx, g.geofence_id,
            CASE WHEN g.kind = 'CIRCLE'
                 THEN ST_DWithin(g.geom::geography,
                                 ST_SetSRID(ST_MakePoint(fx.lng, fx.lat), 4326)::geography,
                                 g.radius_m)
                 ELSE ST_Intersects(g.geom, ST_SetSRID(ST_MakePoint(fx.lng, fx.lat), 4326))
            END AS inside
       FROM geofences g
       CROSS JOIN fixes fx
      WHERE g.geofence_id = ANY($3::uuid[]) AND g.active`, [lats, lngs, fenceIds]);
    // Build status[geofenceIndex][fixIndex]. The matrix MUST cover every
    // (fix, fence) pair exactly once — a missing row would silently read as
    // "outside" and swallow crossings, so we assert cardinality here rather
    // than trusting the SQL shape at replay time (§1.8.3 determinism).
    if (matrix.length !== fixes.length * fenceIds.length) {
        throw new Error(`[crossing] status matrix cardinality mismatch: got ${matrix.length}, ` +
            `expected ${fixes.length}×${fenceIds.length}`);
    }
    const fenceIdx = new Map(fenceIds.map((id, i) => [id, i]));
    const status = fenceIds.map(() => new Array(fixes.length).fill(false));
    for (const r of matrix) {
        const fi = fenceIdx.get(r.geofence_id);
        if (fi == null)
            continue;
        status[fi][Number(r.idx) - 1] = Boolean(r.inside);
    }
    // Diff consecutive fixes per geofence over the GLOBAL event-time sequence, then
    // attribute each crossing to exactly ONE trip. Two facts drove this design
    // (first live-stack run, Gate B):
    //  1. The Trip Engine may split one continuous drive into several trips
    //     (start / park-stop / resume), and trip windows can overlap slightly.
    //     A naive per-trip scan attributed the SAME ENTER timestamp to two trips.
    //  2. The §1.8.3 upsert key is (trip_id, event_type, event_timestamp), so a
    //     duplicate attribution is invisible to the DB yet corrupts reports.
    // Attribution rule: the LATEST-STARTED trip whose [started_at, ended_at]
    // contains the crossing fix wins; if none contains it (edge fix between trips),
    // fall back to the most recently started trip at or before the fix time.
    // Because the diff runs once over the whole fix sequence, each (geofence,
    // transition moment) yields exactly one candidate event regardless of how many
    // trips exist or in what order batches arrived — determinism preserved.
    const events = [];
    for (let gi = 0; gi < fenceIds.length; gi++) {
        const fence = fences[gi];
        let prevInside = false;
        for (let fi = 1; fi < fixes.length; fi++) {
            const prev = fixes[fi - 1], cur = fixes[fi];
            const wasInside = status[gi][fi - 1] ?? false;
            const isInside = status[gi][fi] ?? false;
            // Only report crossings whose event fix lies inside the requested window
            // (the anchor fix at index 0 only informs state at the leading edge).
            if (cur.t < fromMs || cur.t > toMs) {
                prevInside = isInside;
                continue;
            }
            if (isInside !== wasInside) {
                const trip = attributeTrip(tripRows, cur.t);
                if (trip) {
                    events.push({
                        trip_id: trip.trip_id, vehicle_id: vehicleId, driver_id: driverId,
                        geofence_id: fence.geofence_id, geofence_name: fence.name, category: fence.category,
                        event_type: isInside ? 'GEOFENCE_ENTER' : 'GEOFENCE_EXIT',
                        event_timestamp_ms: cur.t, lat: cur.lat, lng: cur.lng,
                    });
                }
                void prev;
            }
            prevInside = isInside;
        }
    }
    return events;
}
/** Deterministic single-trip attribution for a crossing fix (see rules above). */
export function attributeTrip(tripRows, fixT) {
    let containing = null;
    let fallback = null;
    for (const trip of tripRows) {
        const start = new Date(trip.started_at).getTime();
        const end = trip.ended_at ? new Date(trip.ended_at).getTime() : Infinity;
        if (fixT >= start && fixT <= end) {
            // latest-started containing trip wins (tripRows are sorted started_at ASC).
            containing = { trip_id: trip.trip_id, start };
        }
        else if (start <= fixT && (!fallback || start > fallback.start)) {
            fallback = { trip_id: trip.trip_id, start };
        }
    }
    return containing ?? fallback;
}
/** Persist ENTER/EXIT through the §1.8.3 idempotent upsert key. */
export async function persistCrossingEvents(events) {
    for (const e of events) {
        await pool.query(`INSERT INTO trip_events (trip_id, vehicle_id, driver_id, event_type, event_timestamp, lat, lng, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (trip_id, event_type, event_timestamp) DO UPDATE SET
         lat = EXCLUDED.lat, lng = EXCLUDED.lng, payload = EXCLUDED.payload, updated_at = now()`, [e.trip_id, e.vehicle_id, e.driver_id, e.event_type, new Date(e.event_timestamp_ms).toISOString(),
            e.lat, e.lng,
            JSON.stringify({ geofence_id: e.geofence_id, name: e.geofence_name, category: e.category })]);
    }
}
/** Full pipeline used by the composition-root hook: evaluate → persist. */
export async function runCrossingEvaluator(args) {
    const events = await evaluateCrossings(args.vehicleId, args.driverId, args.fromMs, args.toMs);
    if (events.length > 0)
        await persistCrossingEvents(events);
}
//# sourceMappingURL=crossing.js.map