import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';

/**
 * Module 2 — Ingest. Stores raw data ONLY; no trip logic lives here (§1.5).
 * Phase 0 delivers the validated contract + write path; dashboard query endpoints
 * land in Phase 1.
 */

export const LocationFixSchema = z.object({
  fix_timestamp: z.string().datetime(),           // EVENT time from device clock (§1.8.3)
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  speed_mps: z.number().nonnegative().optional(),
  accuracy_m: z.number().nonnegative().optional(),
  heading_deg: z.number().gte(0).lt(360).optional(),
  altitude_m: z.number().optional(),
  provider: z.enum(['gps', 'fused', 'network']).optional(),
});

export const BatchSchema = z.object({
  batch_id: z.string().uuid(),                    // §1.8.2 idempotency key — hard requirement
  client_sent_at: z.string().datetime().optional(),
  fixes: z.array(LocationFixSchema).min(1).max(env.INGEST_MAX_BATCH_FIXES), // ≤100/request (Phase 1)
});

export interface IngestResult {
  accepted: number;
  already_received: boolean;                      // §1.8.2 duplicate replay => 200 true
}

/** Ensure the monthly partition exists for a fix timestamp (late/offline replay may
 *  land in a month not yet pre-created). Cheap: CREATE TABLE IF NOT EXISTS. */
async function ensurePartitions(timestamps: string[]) {
  const months = new Set(timestamps.map((t) => t.slice(0, 7))); // YYYY-MM
  for (const m of months) await pool.query('SELECT ensure_month_partition($1,$2)', ['location_fixes', `${m}-01T00:00:00Z`]);
}

/** Late-binding hook: Trip Engine registers itself here at boot so Ingest stays
 *  free of trip logic (§1.5 "Does NOT own trip logic") while still triggering the
 *  event-time recompute after each accepted batch (§1.8.3). Fire-and-forget:
 *  ingest ACK never waits on trip reconstruction; failures are logged + audited. */
export type RecomputeHook = (args: {
  vehicleId: string; driverId: string; fromMs: number; toMs: number;
}) => Promise<void>;

let recomputeHook: RecomputeHook | null = null;
export function setRecomputeHook(h: RecomputeHook) { recomputeHook = h; }

function triggerRecompute(vehicleId: string | null, driverId: string, times: number[], log?: { warn: (o: unknown, m?: string) => void }) {
  if (!recomputeHook || !vehicleId || times.length === 0) return;
  const min = Math.min(...times), max = Math.max(...times);
  // Window expansion grace mirrors trip_engine.batchWindowMs: look-back for sensor
  // silence checks + one minute forward for trailing transitions.
  const from = min - 180_000, to = max + 60_000;
  void recomputeHook({ vehicleId, driverId, fromMs: from, toMs: to }).catch((err) => {
    (log ?? console).warn?.({ err: String(err), vehicleId }, 'trip recompute failed (will self-heal on read path)');
  });
}

export async function ingestLocationBatch(driverId: string, vehicleId: string | null, body: z.infer<typeof BatchSchema>, log?: { warn: (o: unknown, m?: string) => void }): Promise<IngestResult> {
  // 1) Idempotency gate: unique batch_id. If present, this is an offline replay — ACK again.
  const { rows } = await pool.query(
    `INSERT INTO ingest_batches (batch_id, driver_id, vehicle_id, fix_count, client_sent_at)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (batch_id) DO NOTHING RETURNING batch_id`,
    [body.batch_id, driverId, vehicleId, body.fixes.length, body.client_sent_at ?? null],
  );
  if (rows.length === 0) return { accepted: 0, already_received: true };

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
  event_timestamp: z.string().datetime(),          // EVENT time (§1.8.3)
  kind: z.enum(['accelerometer', 'gyroscope', 'harsh_brake', 'harsh_accel', 'turn', 'vibration_gate', 'audio_engine']),
  payload: z.record(z.unknown()).default({}),      // samples/thresholds/metadata
});

export const SensorBatchSchema = z.object({
  batch_id: z.string().uuid(),                     // §1.8.2 idempotency key — same contract as fixes
  client_sent_at: z.string().datetime().optional(),
  events: z.array(SensorEventSchema).min(1).max(env.INGEST_MAX_BATCH_SENSORS),
});

async function ensureSensorPartitions(timestamps: string[]) {
  const months = new Set(timestamps.map((t) => t.slice(0, 7)));
  for (const m of months) await pool.query('SELECT ensure_month_partition($1,$2)', ['sensor_events', `${m}-01T00:00:00Z`]);
}

export async function ingestSensorBatch(driverId: string, vehicleId: string | null, body: z.infer<typeof SensorBatchSchema>, log?: { warn: (o: unknown, m?: string) => void }): Promise<IngestResult> {
  const { rows } = await pool.query(
    `INSERT INTO ingest_batches (batch_id, driver_id, vehicle_id, fix_count, sensor_count, client_sent_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (batch_id) DO NOTHING RETURNING batch_id`,
    [body.batch_id, driverId, vehicleId, 0, body.events.length, body.client_sent_at ?? null],
  );
  if (rows.length === 0) return { accepted: 0, already_received: true };
  if (!vehicleId) throw Object.assign(new Error('no_vehicle_assignment'), { statusCode: 409 });

  await ensureSensorPartitions(body.events.map((e) => e.event_timestamp));
  let total = 0;
  const CHUNK = 500; // §1.10.1 batch writes only
  for (let i = 0; i < body.events.length; i += CHUNK) {
    const chunk = body.events.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((e, ri) => {
      const base = ri * 5;
      params.push(body.batch_id, vehicleId, driverId, e.event_timestamp, e.kind, JSON.stringify(e.payload));
      // Explicit casts: node-postgres infers jsonb/unknown for string params in a
      // multi-row VALUES list; uuid/text columns need the type annotated (PG 42804).
      return `($${base+1}::uuid,$${base+2},$${base+3},$${base+4},$${base+5},$${base+6}::jsonb)`;
    });
    const res = await pool.query(
      `INSERT INTO sensor_events (batch_id, vehicle_id, driver_id, event_timestamp, kind, payload)
       VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
    total += res.rowCount ?? 0;
  }
  // Sensor arrivals also shift separation/silence conclusions → recompute window.
  triggerRecompute(vehicleId, driverId, body.events.map((e) => Date.parse(e.event_timestamp)), log);
  return { accepted: total, already_received: false };
}

/** Injection-safe variant: placeholders for coordinates inside PostGIS call. */
async function insertManySafe(batchId: string, vehicleId: string, driverId: string, fixes: z.infer<typeof LocationFixSchema>[]) {
  let total = 0;
  const CHUNK = 500; // §1.10.1 accumulate up to 500 rows per statement
  for (let i = 0; i < fixes.length; i += CHUNK) {
    const chunk = fixes.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((f, ri) => {
      const base = ri * 11;
      params.push(batchId, vehicleId, driverId, f.fix_timestamp, f.lat, f.lng,
                  f.speed_mps ?? null, f.accuracy_m ?? null, f.heading_deg ?? null,
                  f.altitude_m ?? null, f.provider ?? 'gps');
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},
               ST_SetSRID(ST_MakePoint($${base+6}, $${base+5}), 4326))`;
    });
    const res = await pool.query(
      `INSERT INTO location_fixes
         (batch_id, vehicle_id, driver_id, fix_timestamp, lat, lng, speed_mps, accuracy_m,
          heading_deg, altitude_m, provider, geom) VALUES ${tuples.join(',')}
       ON CONFLICT DO NOTHING`, params);
    total += res.rowCount ?? 0;
  }
  return { rowCount: total };
}
