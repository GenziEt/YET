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

export async function ingestLocationBatch(driverId: string, vehicleId: string | null, body: z.infer<typeof BatchSchema>): Promise<IngestResult> {
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

  return { accepted: rowCount, already_received: false };
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
