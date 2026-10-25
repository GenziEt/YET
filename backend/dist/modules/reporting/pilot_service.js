import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { estimateTripDrain, judgePilotBattery, reconstructionAccuracy, BATTERY_TARGET_PCT_PER_SHIFT, BATTERY_GATE_MAX_PCT_PER_SHIFT, RECONSTRUCTION_MIN_ACCURACY, } from '../trip_engine/pilot_battery.js';
/**
 * Module 6 (Reporting) — READ-ONLY pilot rollup for the Phase 4 field pilot.
 * Deliverable: "Pilot dashboard: per-driver battery drain estimate (from
 * app-reported battery level at trip start/end), upload latency, separation
 * event count, sync backlog." Reporting owns NO primary tables (§1.5); it reads
 * Ingest + Trip Engine data only. When Reporting is extracted to a service the
 * whole folder moves with it — keep imports limited to shared lib/ and other
 * modules' exported kernels (pilot_battery.ts is pure, so importing it is safe).
 *
 * All window math uses EVENT times (fix/battery timestamps), never received_at,
 * so an offline-replayed day produces identical pilot numbers to a live day
 * (§1.8.3). Upload latency is the one deliberately arrival-based metric:
 * received_at − client_sent_at measures the network path itself.
 */
export const PilotQuerySchema = z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    driver_id: z.string().uuid().optional(),
    /** Phase 0 tenant scoping (route-injected, never client-supplied): when set,
     *  every aggregate below is confined to this fleet's drivers. */
    fleet_id: z.string().uuid().optional(),
});
async function loadBatteryRows(fromIso, toIso, driverId, fleetId) {
    const conds = ['trip_started_at >= $1', 'trip_started_at < $2'];
    const params = [fromIso, toIso];
    if (driverId) {
        params.push(driverId);
        conds.push(`driver_id = $${params.length}`);
    }
    // Fleet-scoped pilot reads join through users so a FLEET_MANAGER only ever
    // aggregates their own drivers' battery samples (§1.7 minimization).
    if (fleetId) {
        params.push(fleetId);
        conds.push(`EXISTS (SELECT 1 FROM users fu WHERE fu.id = trip_battery_samples.driver_id AND fu.fleet_id = $${params.length})`);
    }
    const { rows } = await pool.query(`SELECT driver_id, vehicle_id, trip_started_at, phase, battery_pct, charging, taken_at
       FROM trip_battery_samples
      WHERE ${conds.join(' AND ')}`, params);
    return rows;
}
/** Group samples by (vehicle, trip-start) and run the pure drain kernel per trip. */
export function buildDrainEstimates(rows) {
    const byTrip = new Map();
    for (const r of rows) {
        const anchorMs = new Date(r.trip_started_at).getTime();
        const key = `${r.vehicle_id}|${anchorMs}`;
        const slot = byTrip.get(key) ?? { start: null, end: null, anchorMs };
        const sample = { takenAtMs: new Date(r.taken_at).getTime(), pct: Number(r.battery_pct), charging: r.charging };
        if (r.phase === 'trip_start')
            slot.start = sample;
        else if (r.phase === 'trip_end')
            slot.end = sample;
        byTrip.set(key, slot);
    }
    return [...byTrip.values()].map((s) => estimateTripDrain(s.anchorMs, s.start, s.end));
}
/** Per-driver median across their trips (pilot fleet = 5–10 trucks). */
async function perDriverDrain(rows) {
    const byDriver = new Map();
    for (const r of rows) {
        const list = byDriver.get(r.driver_id) ?? [];
        list.push(r);
        byDriver.set(r.driver_id, list);
    }
    const out = [];
    for (const [driverId, drvRows] of byDriver) {
        const usable = buildDrainEstimates(drvRows)
            .map((e) => e.drain_pct_per_8h)
            .filter((v) => v !== null);
        const { rows: names } = await pool.query(`SELECT u.full_name, v.plate_number
         FROM users u
         LEFT JOIN driver_vehicle_assignments dva ON dva.driver_id = u.id AND dva.unassigned_at IS NULL
         LEFT JOIN vehicles v ON v.id = dva.vehicle_id
        WHERE u.id = $1 LIMIT 1`, [driverId]);
        if (usable.length === 0)
            continue;
        const sorted = [...usable].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        out.push({
            driver_id: driverId,
            driver_name: names[0]?.full_name ?? null,
            plate_number: names[0]?.plate_number ?? null,
            trips_measured: sorted.length,
            median_pct_per_8h: Math.round(med * 10) / 10,
        });
    }
    return out.sort((a, b) => (b.median_pct_per_8h ?? 0) - (a.median_pct_per_8h ?? 0));
}
async function uploadLatency(fromIso, toIso, driverId, fleetId) {
    // p50/p95 of (received_at - client_sent_at) over batches arriving in the window.
    const { rows } = await pool.query(`SELECT
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (b.received_at - b.client_sent_at))) AS p50_s,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (b.received_at - b.client_sent_at))) AS p95_s,
       COUNT(*)::int AS batches
     FROM ingest_batches b
     WHERE b.client_sent_at IS NOT NULL AND b.received_at >= $1 AND b.received_at < $2
       AND ($3::uuid IS NULL OR b.driver_id = $3)
       AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM users fu WHERE fu.id = b.driver_id AND fu.fleet_id = $4))`, [fromIso, toIso, driverId ?? null, fleetId ?? null]);
    const r = rows[0] ?? {};
    return {
        p50_seconds: r.p50_s != null ? Math.round(Number(r.p50_s)) : null,
        p95_seconds: r.p95_s != null ? Math.round(Number(r.p95_s)) : null,
        batches: Number(r.batches ?? 0),
    };
}
async function separationCounts(fromIso, toIso, driverId, fleetId) {
    const { rows } = await pool.query(`SELECT dsl.vehicle_id, v.plate_number,
            COUNT(*)::int AS incidents,
            COUNT(*) FILTER (WHERE dsl.returned_at IS NULL)::int AS open_now,
            ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(dsl.returned_at, now()) - dsl.separated_at)) / 60)::numeric, 1)::float AS avg_minutes
       FROM driver_separation_log dsl
       LEFT JOIN vehicles v ON v.id = dsl.vehicle_id
      WHERE dsl.separated_at >= $1 AND dsl.separated_at < $2
        AND ($3::uuid IS NULL OR dsl.driver_id = $3)
        AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM users fu WHERE fu.id = dsl.driver_id AND fu.fleet_id = $4))
      GROUP BY dsl.vehicle_id, v.plate_number
      ORDER BY incidents DESC`, [fromIso, toIso, driverId ?? null, fleetId ?? null]);
    return rows;
}
/** Sync backlog proxy: fixes whose server copy arrived >10 min after their EVENT
 *  time were collected offline — how deep the offline buffers ran in the field. */
async function syncBacklog(fromIso, toIso, driverId, fleetId) {
    const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (received_at - fix_timestamp)) > 600)::int AS late_fixes,
            COUNT(*)::int AS total_fixes,
            COALESCE(MAX(EXTRACT(EPOCH FROM (received_at - fix_timestamp))), 0)::int AS worst_lag_s
       FROM location_fixes lf
      WHERE fix_timestamp >= $1 AND fix_timestamp < $2
        AND ($3::uuid IS NULL OR driver_id = $3)
        AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM users fu WHERE fu.id = lf.driver_id AND fu.fleet_id = $4))`, [fromIso, toIso, driverId ?? null, fleetId ?? null]);
    return rows[0] ?? { late_fixes: 0, total_fixes: 0, worst_lag_s: 0 };
}
/**
 * Offline reconstruction audit (§Phase 4 gate: ≥95% of offline-period GPS fixes
 * appear correctly on the dashboard). Server-side view: batches that carried
 * offline-collected data (arrival lag > 10 min) must have stored EVERY fix the
 * client said it sent — accepted == fix_count means zero silent loss through
 * idempotent replay (§1.8.2) and partition writes (§1.10.1).
 */
async function reconstructionAudit(fromIso, toIso, driverId, fleetId) {
    const { rows } = await pool.query(`WITH offline_batches AS (
       SELECT b.batch_id, b.fix_count
         FROM ingest_batches b
        WHERE b.fix_count > 0 AND b.client_sent_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM location_fixes lf
             WHERE lf.batch_id = b.batch_id
               AND lf.fix_timestamp >= $1 AND lf.fix_timestamp < $2
               AND EXTRACT(EPOCH FROM (lf.received_at - lf.fix_timestamp)) > 600
               AND ($3::uuid IS NULL OR lf.driver_id = $3)
               AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM users fu WHERE fu.id = lf.driver_id AND fu.fleet_id = $4)))
     ),
     stored AS (
       SELECT lf.batch_id, COUNT(DISTINCT (lf.fix_timestamp, lf.lat, lf.lng))::int AS n
         FROM location_fixes lf JOIN offline_batches ob ON ob.batch_id = lf.batch_id
        GROUP BY lf.batch_id
     )
     SELECT COALESCE(SUM(ob.fix_count), 0)::int AS sent_fixes,
            COALESCE(SUM(COALESCE(s.n, 0)), 0)::int AS stored_fixes,
            COUNT(*)::int AS offline_batches
       FROM offline_batches ob LEFT JOIN stored s ON s.batch_id = ob.batch_id`, [fromIso, toIso, driverId ?? null, fleetId ?? null]);
    const r = rows[0] ?? { sent_fixes: 0, stored_fixes: 0, offline_batches: 0 };
    const input = { offline_sent: Number(r.sent_fixes), offline_stored: Number(r.stored_fixes) };
    return {
        ...input,
        offline_batches: Number(r.offline_batches ?? 0),
        accuracy: Math.round(reconstructionAccuracy(input) * 10000) / 10000,
        gate_passed: reconstructionAccuracy(input) >= RECONSTRUCTION_MIN_ACCURACY,
    };
}
/** Untriaged one-tap driver feedback (ops runbook queue). */
async function openDiagnostics(driverId, fleetId) {
    const { rows } = await pool.query(`SELECT d.diag_id, d.batch_id, d.driver_id, u.full_name AS driver_name, d.reported_at,
            d.issue, d.battery_pct, d.last_fix_age_s, d.last_accuracy_m, d.network_type,
            d.pending_sync_count, d.trip_active, d.app_version
       FROM driver_diagnostics d
       JOIN users u ON u.id = d.driver_id
      WHERE NOT d.triaged AND ($1::uuid IS NULL OR d.driver_id = $1)
        AND ($2::uuid IS NULL OR u.fleet_id = $2)
      ORDER BY d.reported_at DESC
      LIMIT 100`, [driverId ?? null, fleetId ?? null]);
    return rows;
}
export async function getPilotSummary(q) {
    const rows = await loadBatteryRows(q.from, q.to, q.driver_id, q.fleet_id);
    const estimates = buildDrainEstimates(rows);
    const battery = judgePilotBattery(estimates);
    return {
        window: { from: q.from, to: q.to },
        thresholds: {
            target_pct_per_8h: BATTERY_TARGET_PCT_PER_SHIFT,
            gate_max_pct_per_8h: BATTERY_GATE_MAX_PCT_PER_SHIFT,
            reconstruction_min_accuracy: RECONSTRUCTION_MIN_ACCURACY,
        },
        battery: { ...battery, trips_with_samples: estimates.length },
        per_driver: await perDriverDrain(rows),
        upload_latency: await uploadLatency(q.from, q.to, q.driver_id, q.fleet_id),
        separations: await separationCounts(q.from, q.to, q.driver_id, q.fleet_id),
        sync_backlog: await syncBacklog(q.from, q.to, q.driver_id, q.fleet_id),
        reconstruction_audit: await reconstructionAudit(q.from, q.to, q.driver_id, q.fleet_id),
        open_driver_reports: await openDiagnostics(q.driver_id, q.fleet_id),
    };
}
//# sourceMappingURL=pilot_service.js.map