import { z } from 'zod';
import { pool } from '../../db/pool.js';
/**
 * Phase 1 read side of Module 2 (Ingest). The dashboard's raw-fixes view binds to
 * these queries. Ingest still owns NO trip logic (§1.5) — this is pure retrieval of
 * stored raw data, ordered by EVENT time (§1.8.3), never by received_at.
 */
export const FixQuerySchema = z.object({
    driver_id: z.string().uuid(),
    from: z.string().datetime(),
    to: z.string().datetime(),
    limit: z.coerce.number().int().positive().max(5000).default(2000),
});
/** Fixes for one driver in [from, to), ascending by event time — polyline order.
 *  Uses idx_fixes_driver_time (driver_id, fix_timestamp) exactly as §1.10.1 allows;
 *  there is deliberately no lat/lng index. */
export async function listFixes(q) {
    const { rows } = await pool.query(`SELECT fix_timestamp, lat, lng, speed_mps, accuracy_m, heading_deg, provider, batch_id
       FROM location_fixes
      WHERE driver_id = $1 AND fix_timestamp >= $2 AND fix_timestamp < $3
      ORDER BY fix_timestamp ASC, fix_id ASC
      LIMIT $4`, [q.driver_id, q.from, q.to, q.limit]);
    return rows;
}
/** Lightweight fleet roster for the dashboard selector: drivers with recent activity.
 *  "Recent" window keeps the scan on the (driver_id, fix_timestamp) index. */
export async function listActiveDrivers(sinceIso) {
    const { rows } = await pool.query(`SELECT d.driver_id,
            u.full_name,
            v.plate_number,
            v.id AS vehicle_id,
            max(d.fix_timestamp) AS last_fix_at
       FROM location_fixes d
       JOIN users u   ON u.id = d.driver_id
  LEFT JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.fix_timestamp >= $1
   GROUP BY d.driver_id, u.full_name, v.plate_number, v.id
   ORDER BY last_fix_at DESC NULLS LAST
      LIMIT 200`, [sinceIso]);
    return rows;
}
//# sourceMappingURL=read_service.js.map