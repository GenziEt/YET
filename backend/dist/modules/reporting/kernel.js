/**
 * Module 6 — Reporting: pure helpers (Phase 5, B).
 *
 * Zero I/O, zero clock reads — same discipline as notification/kernel.ts and
 * trip_engine/state_machine.ts. The reporting service is the I/O shell; these
 * functions are the testable core (§F vitest units import them directly).
 */
/** Haversine great-circle distance in km (WGS84 mean radius). */
export function haversineKm(a, b) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}
/**
 * Bucket trips into ISO-ish weeks (Monday-anchored) by START event time (§1.8.3:
 * grouping keys off stored event times, never arrival/received times). Purely
 * calendar-driven — no `now()` inside — so weekly report output is reproducible.
 */
export function bucketTripsByWeek(rows, tzOffsetMs = 3 * 3600_000) {
    const buckets = new Map();
    for (const r of rows) {
        const local = new Date(new Date(r.started_at).getTime() + tzOffsetMs); // EAT = UTC+3
        const y = local.getUTCFullYear();
        const m = local.getUTCMonth();
        const d = local.getUTCDate();
        const dow = local.getUTCDay(); // 0=Sun..6=Sat
        const monday = new Date(Date.UTC(y, m, d - ((dow + 6) % 7)));
        const key = monday.toISOString().slice(0, 10);
        const cur = buckets.get(key) ?? { trips: 0, distance_km: 0 };
        cur.trips += 1;
        cur.distance_km += Number(r.distance_m) / 1000;
        buckets.set(key, cur);
    }
    return [...buckets.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([week_start, v]) => ({ week_start, trips: v.trips, distance_km: Math.round(v.distance_km * 100) / 100 }));
}
/** Weekly-trip totals per driver over a window — used by getTripReport summary. */
export function summarizeTrips(rows) {
    const sum = rows.reduce((acc, r) => ({
        trip_count: acc.trip_count + 1,
        total_distance_km: acc.total_distance_km + Number(r.distance_m) / 1000,
        total_moving_s: acc.total_moving_s + Number(r.moving_duration_s),
        total_stopped_s: acc.total_stopped_s + Number(r.stopped_duration_s),
        turn_count: acc.turn_count + Number(r.turn_count),
        harsh_event_count: acc.harsh_event_count + Number(r.harsh_event_count),
    }), { trip_count: 0, total_distance_km: 0, total_moving_s: 0, total_stopped_s: 0, turn_count: 0, harsh_event_count: 0 });
    return { ...sum, total_distance_km: Math.round(sum.total_distance_km * 100) / 100 };
}
/**
 * Merge latest-fix + open-trip rows into the dashboard's fleet-state payload.
 * Determinism: everything derives from the passed-in `nowMs` (the instant the
 * aggregate was computed — cached alongside it), so a cache HIT re-renders the
 * exact same ages/flags until TTL expiry replaces it with a fresh snapshot.
 */
export function buildFleetOverview(input) {
    const statusByVehicle = new Map(input.statuses.map((s) => [s.vehicle_id, s]));
    const fixByVehicle = new Map(input.fixes.map((f) => [f.vehicle_id, f]));
    const vehicleIds = new Set([...statusByVehicle.keys(), ...fixByVehicle.keys()]);
    const vehicles = [];
    let onTrip = 0, separatedOpen = 0, stale = 0, offline = 0;
    for (const vid of [...vehicleIds].sort()) {
        const fix = fixByVehicle.get(vid) ?? null;
        const status = statusByVehicle.get(vid) ?? null;
        const ageS = fix ? Math.max(0, Math.round((input.nowMs - new Date(fix.fix_timestamp).getTime()) / 1000)) : null;
        const isLive = ageS !== null && ageS <= input.liveWindowS;
        if (!isLive)
            offline++;
        if (ageS !== null && ageS > input.liveWindowS * 4)
            stale++;
        if (status)
            onTrip++;
        if (status?.separation_open)
            separatedOpen++;
        vehicles.push({
            vehicle_id: vid,
            plate_number: fix?.plate_number ?? null,
            driver_id: status?.driver_id ?? fix?.driver_id ?? null,
            driver_name: fix?.driver_name ?? null,
            last_fix: fix
                ? { at: fix.fix_timestamp, lat: fix.lat, lng: fix.lng, speed_mps: fix.speed_mps, accuracy_m: fix.accuracy_m }
                : null,
            trip: status
                ? {
                    vehicle_id: status.vehicle_id, trip_id: status.trip_id, driver_id: status.driver_id,
                    state: status.state, started_at: status.started_at, last_activity_at: status.last_activity_at,
                    separation_open: status.separation_open, separated_minutes: status.separated_minutes,
                    notified: status.notified,
                }
                : null,
            last_fix_age_s: ageS,
            is_live: isLive,
        });
    }
    return {
        generated_at: new Date(input.nowMs).toISOString(),
        vehicles,
        counts: { total: vehicles.length, on_trip: onTrip, separated_open: separatedOpen, stale, offline },
    };
}
/** Redis key for the 30s fleet-state cache (§1.10.2 / Phase 5 spec). */
export const FLEET_STATE_CACHE_KEY = 'fleet:state';
export const FLEET_STATE_TTL_S = 30;
/** A fix older than this is shown as "last known location", not a live position (§1.4). */
export const FLEET_LIVE_WINDOW_S = 120;
//# sourceMappingURL=kernel.js.map