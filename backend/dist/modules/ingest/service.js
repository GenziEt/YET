import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';
/**
 * Module 2 — Ingest. Stores raw data ONLY; no trip logic lives here (§1.5).
 * Phase 0 delivers the validated contract + write path; dashboard query endpoints
 * land in Phase 1.
 */
export const LocationFixSchema = z.object({
    fix_timestamp: z.string().datetime(), // EVENT time from device clock (§1.8.3)
    lat: z.number().gte(-90).lte(90),
    lng: z.number().gte(-180).lte(180),
    speed_mps: z.number().nonnegative().optional(),
    accuracy_m: z.number().nonnegative().optional(),
    heading_deg: z.number().gte(0).lt(360).optional(),
    altitude_m: z.number().optional(),
    provider: z.enum(['gps', 'fused', 'network']).optional(),
});
export const BatchSchema = z.object({
    batch_id: z.string().uuid(), // §1.8.2 idempotency key — hard requirement
    client_sent_at: z.string().datetime().optional(),
    fixes: z.array(LocationFixSchema).min(1).max(env.INGEST_MAX_BATCH_FIXES), // ≤100/request (Phase 1)
});
/** Ensure the monthly partition exists for a fix timestamp (late/offline replay may
 *  land in a month not yet pre-created). Cheap: CREATE TABLE IF NOT EXISTS. */
async function ensurePartitions(timestamps) {
    const months = new Set(timestamps.map((t) => t.slice(0, 7))); // YYYY-MM
    for (const m of months)
        await pool.query('SELECT ensure_month_partition($1,$2)', ['location_fixes', `${m}-01T00:00:00Z`]);
}
let recomputeHook = null;
export function setRecomputeHook(h) { recomputeHook = h; }
/**
 * Phase 5 (A4): SECOND late-binding seam on the same chain — Notification's
 * composition-root trigger runs AFTER trip reconstruction + crossing persistence
 * so it sees the trip_events this window just produced. Same fire-and-forget
 * contract as recomputeHook: ingest ACK never waits on notification work, and a
 * failed pass self-heals on the next batch/recompute (dedupe makes retries free).
 * Kept SEPARATE from recomputeHook so an existing hook consumer (tests that
 * install their own) can never accidentally starve notifications.
 */
let notifyHook = null;
export function setNotifyHook(h) { notifyHook = h; }
function triggerRecompute(vehicleId, driverId, times, log) {
    if ((!recomputeHook && !notifyHook) || !vehicleId || times.length === 0)
        return;
    const min = Math.min(...times), max = Math.max(...times);
    // Window expansion grace mirrors trip_engine.batchWindowMs: look-back for sensor
    // silence checks + one minute forward for trailing transitions.
    const from = min - 180_000, to = max + 60_000;
    // Chain order matters (§A4): trips/events first, notifications LAST so they see
    // freshly persisted TRIP_*/GEOFENCE_* rows. Await the recompute chain before
    // firing notifyHook — both are fire-and-forget w.r.t. the ingest ACK.
    const chain = (recomputeHook
        ? recomputeHook({ vehicleId, driverId, fromMs: from, toMs: to })
        : Promise.resolve()).then(() => notifyHook?.({ vehicleId, driverId, fromMs: from, toMs: to }))
        .catch((err) => {
        (log ?? console).warn?.({ err: String(err), vehicleId }, 'trip recompute failed (will self-heal on read path)');
    });
    void chain;
}
export async function ingestLocationBatch(driverId, vehicleId, body, log) {
    // 1) Idempotency gate: unique batch_id. If present, this is an offline replay — ACK again.
    const { rows } = await pool.query(`INSERT INTO ingest_batches (batch_id, driver_id, vehicle_id, fix_count, client_sent_at)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (batch_id) DO NOTHING RETURNING batch_id`, [body.batch_id, driverId, vehicleId, body.fixes.length, body.client_sent_at ?? null]);
    if (rows.length === 0)
        return { accepted: 0, already_received: true };
    // 2) Partition safety for event-time range, then single batched INSERT (§1.10.1):
    //    never one INSERT per fix. ON CONFLICT DO NOTHING makes row-level replay safe.
    await ensurePartitions(body.fixes.map((f) => f.fix_timestamp));
    const { rowCount } = await insertManySafe(body.batch_id, vehicleId ?? driverId, driverId, body.fixes);
    // 3) Event-time recompute of the affected window (§1.8.3) — fire-and-forget.
    triggerRecompute(vehicleId, driverId, body.fixes.map((f) => Date.parse(f.fix_timestamp)), log);
    return { accepted: rowCount, already_received: false };
}
/* --------------------------- Sensor batches (Phase 2) ----------------------- */
export const SensorEventSchema = z.object({
    event_timestamp: z.string().datetime(), // EVENT time (§1.8.3)
    kind: z.enum(['accelerometer', 'gyroscope', 'harsh_brake', 'harsh_accel', 'turn', 'vibration_gate']),
    payload: z.record(z.unknown()).default({}), // samples/thresholds/metadata
});
export const SensorBatchSchema = z.object({
    batch_id: z.string().uuid(), // §1.8.2 idempotency key — same contract as fixes
    client_sent_at: z.string().datetime().optional(),
    events: z.array(SensorEventSchema).min(1).max(env.INGEST_MAX_BATCH_SENSORS),
});
/**
 * Pure wire-format check for a sensor batch, split out of [ingestSensorBatch]
 * so the §1.8.2 replay-idempotency CONTRACT (batch envelope + per-event shape
 * the driver app's SensorDao/encodeSensorBatchBody produces) is unit-testable
 * without a database. The INSERT path below still enforces it at the boundary
 * via SensorBatchSchema; this helper is the same ruleset used by tests and by
 * any pre-flight validation callers. Duplicate-batch REPLAY itself is handled
 * by the ingest_batches.batch_id PK: ON CONFLICT DO NOTHING → already_received.
 */
export function validateSensorBatchPayload(body) {
    return SensorBatchSchema.parse(body);
}
async function ensureSensorPartitions(timestamps) {
    const months = new Set(timestamps.map((t) => t.slice(0, 7)));
    for (const m of months)
        await pool.query('SELECT ensure_month_partition($1,$2)', ['sensor_events', `${m}-01T00:00:00Z`]);
}
export async function ingestSensorBatch(driverId, vehicleId, body, log) {
    const { rows } = await pool.query(`INSERT INTO ingest_batches (batch_id, driver_id, vehicle_id, fix_count, sensor_count, client_sent_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (batch_id) DO NOTHING RETURNING batch_id`, [body.batch_id, driverId, vehicleId, 0, body.events.length, body.client_sent_at ?? null]);
    if (rows.length === 0)
        return { accepted: 0, already_received: true };
    if (!vehicleId)
        throw Object.assign(new Error('no_vehicle_assignment'), { statusCode: 409 });
    await ensureSensorPartitions(body.events.map((e) => e.event_timestamp));
    let total = 0;
    const CHUNK = 500; // §1.10.1 batch writes only
    for (let i = 0; i < body.events.length; i += CHUNK) {
        const chunk = body.events.slice(i, i + CHUNK);
        const params = [];
        const tuples = chunk.map((e, ri) => {
            const base = ri * 6; // 6 params per row: batch_id, vehicle_id, driver_id, ts, kind, payload
            params.push(body.batch_id, vehicleId, driverId, e.event_timestamp, e.kind, JSON.stringify(e.payload));
            // Explicit casts on EVERY column: node-postgres sends untyped string params
            // as unknown and Postgres mis-infers types across a multi-row VALUES list
            // when one param is JSON text (PG 42804: "column batch_id is of type uuid
            // but expression is of type jsonb"). Annotate each placeholder precisely.
            // NOTE: the payload param must be ::text::jsonb, NOT ::jsonb directly —
            // PG has no jsonb→uuid assignment cast, so if Postgres propagates the
            // jsonb type leftward across the VALUES list (e.g. into the batch_id uuid
            // column), a direct $n::jsonb fails with 42846 "cannot cast type jsonb to
            // uuid". Casting through text keeps every column's target-type inference
            // unambiguous.
            return `($${base + 1}::uuid,$${base + 2}::uuid,$${base + 3}::uuid,$${base + 4}::timestamptz,$${base + 5}::text,$${base + 6}::text::jsonb)`;
        });
        const res = await pool.query(`INSERT INTO sensor_events (batch_id, vehicle_id, driver_id, event_timestamp, kind, payload)
       VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
        total += res.rowCount ?? 0;
    }
    // Sensor arrivals also shift separation/silence conclusions → recompute window.
    triggerRecompute(vehicleId, driverId, body.events.map((e) => Date.parse(e.event_timestamp)), log);
    return { accepted: total, already_received: false };
}
/** Injection-safe variant: placeholders for coordinates inside PostGIS call. */
async function insertManySafe(batchId, vehicleId, driverId, fixes) {
    let total = 0;
    const CHUNK = 500; // §1.10.1 accumulate up to 500 rows per statement
    for (let i = 0; i < fixes.length; i += CHUNK) {
        const chunk = fixes.slice(i, i + CHUNK);
        const params = [];
        const tuples = chunk.map((f, ri) => {
            const base = ri * 11;
            params.push(batchId, vehicleId, driverId, f.fix_timestamp, f.lat, f.lng, f.speed_mps ?? null, f.accuracy_m ?? null, f.heading_deg ?? null, f.altitude_m ?? null, f.provider ?? 'gps');
            return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},
               ST_SetSRID(ST_MakePoint($${base + 6}, $${base + 5}), 4326))`;
        });
        const res = await pool.query(`INSERT INTO location_fixes
         (batch_id, vehicle_id, driver_id, fix_timestamp, lat, lng, speed_mps, accuracy_m,
          heading_deg, altitude_m, provider, geom) VALUES ${tuples.join(',')}
       ON CONFLICT DO NOTHING`, params);
        total += res.rowCount ?? 0;
    }
    return { rowCount: total };
}
/* --------------------- Pilot telemetry (Phase 4) ---------------------------- */
/**
 * POST /ingest/battery — app-reported battery level at trip start/end (§Phase 4
 * deliverable: "per-driver battery drain estimate from app-reported battery level
 * at trip start/end"). Carried inside the SAME Offline Contract envelope as every
 * other record type: UUID batch_id idempotency (§1.8.2), device-clock event times
 * (§1.8.3), per-driver rate limit (§1.10.4). Samples anchor to a trip by its
 * EVENT-TIME start (trip_started_at = timestamp of the first fix of that trip),
 * so offline replay attaches them to the correct trip regardless of arrival order.
 */
export const BatterySampleSchema = z.object({
    batch_id: z.string().uuid(),
    client_sent_at: z.string().datetime().optional(),
    samples: z.array(z.object({
        trip_started_at: z.string().datetime(), // event time of TRIP_STARTED fix
        taken_at: z.string().datetime(), // event time of the reading
        phase: z.enum(['trip_start', 'trip_end', 'mid_trip']),
        battery_pct: z.number().gte(0).lte(100),
        charging: z.boolean().default(false),
    })).min(1).max(64), // one trip contributes ≤3; 64 covers a multi-trip backlog flush
});
export async function ingestBatteryBatch(driverId, vehicleId, body) {
    if (!vehicleId)
        throw Object.assign(new Error('no_vehicle_assignment'), { statusCode: 409 });
    // Idempotency gate identical to locations/sensors: duplicate batch => ACK true.
    const { rows } = await pool.query(`INSERT INTO ingest_batches (batch_id, driver_id, vehicle_id, fix_count, sensor_count, client_sent_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (batch_id) DO NOTHING RETURNING batch_id`, [body.batch_id, driverId, vehicleId, 0, 0, body.client_sent_at ?? null]);
    if (rows.length === 0)
        return { accepted: 0, already_received: true };
    let total = 0;
    for (const s of body.samples) {
        // Natural-key upsert: replayed/offline batches converge to ONE sample per
        // (vehicle, trip, phase) — no duplicated pilot statistics (§1.8.2 spirit).
        const res = await pool.query(`INSERT INTO trip_battery_samples
         (batch_id, driver_id, vehicle_id, trip_started_at, taken_at, phase, battery_pct, charging)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (vehicle_id, trip_started_at, phase) DO UPDATE SET
         taken_at = EXCLUDED.taken_at, battery_pct = EXCLUDED.battery_pct,
         charging = EXCLUDED.charging, received_at = now()`, [body.batch_id, driverId, vehicleId, s.trip_started_at, s.taken_at, s.phase, s.battery_pct, s.charging]);
        total += res.rowCount ?? 0;
    }
    return { accepted: total, already_received: false };
}
/**
 * POST /ingest/diagnostics — one-tap in-app feedback payload (§Phase 4):
 * issue + battery level + GPS accuracy + last-fix age + network type + pending
 * sync count. batch_id gives the same duplicate-tap safety as data batches: a
 * driver who taps repeatedly while offline must not multiply incidents once the
 * tower comes back.
 */
export const DiagnosticsSchema = z.object({
    batch_id: z.string().uuid(),
    reported_at: z.string().datetime(), // event time from device clock
    issue: z.enum(['gps_not_working', 'battery_drain', 'sync_stuck', 'other']),
    battery_pct: z.number().gte(0).lte(100).optional(),
    charging: z.boolean().optional(),
    last_fix_age_s: z.number().int().nonnegative().optional(),
    last_accuracy_m: z.number().nonnegative().optional(),
    network_type: z.enum(['wifi', 'cellular', 'none', 'unknown']).default('unknown'),
    pending_sync_count: z.number().int().nonnegative().default(0),
    trip_active: z.boolean().default(false),
    app_version: z.string().max(64).optional(),
    detail: z.record(z.unknown()).default({}),
});
export async function ingestDiagnostics(driverId, vehicleId, body) {
    const { rows } = await pool.query(`INSERT INTO driver_diagnostics
       (batch_id, driver_id, vehicle_id, reported_at, issue, battery_pct, charging,
        last_fix_age_s, last_accuracy_m, network_type, pending_sync_count, trip_active,
        app_version, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (batch_id) DO NOTHING
     RETURNING diag_id`, [body.batch_id, driverId, vehicleId, body.reported_at, body.issue,
        body.battery_pct ?? null, body.charging ?? null, body.last_fix_age_s ?? null,
        body.last_accuracy_m ?? null, body.network_type, body.pending_sync_count,
        body.trip_active, body.app_version ?? null, JSON.stringify(body.detail)]);
    if (rows.length === 0)
        return { accepted: 0, already_received: true };
    return { accepted: 1, already_received: false };
}
//# sourceMappingURL=service.js.map