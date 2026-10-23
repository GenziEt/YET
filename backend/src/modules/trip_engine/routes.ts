import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyAccessToken } from '../../lib/jwt.js';
import { pool } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { getTripStatusForVehicle, listTrips, getTripDetail } from './service.js';

/**
 * Module 3 — Trip Engine HTTP surface (Phase 2).
 * Internal API (§1.5): GET /trips/status?vehicle_id= — "current trip status for vehicle X".
 * Dashboard reads: GET /trips (list), GET /trips/:id (detail incl. events+separations).
 */

async function auth(req: any): Promise<{ id: string; role: string }> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  return verifyAccessToken(header.slice(7));
}

/** Drivers see only their own trips; fleet managers/admins see all (§1.7 minimization). */
function scopeFilter(claims: { id: string; role: string }, queryDriverId?: string): string | undefined {
  if (claims.role === 'DRIVER') return claims.id;
  return queryDriverId;
}

export default async function tripRoutes(app: FastifyInstance) {
  /** GET /trips?driver_id=&vehicle_id=&from=&to=&status=&limit= — p95 ≤ 200 ms budget
   *  covers 50 rows (§1.9.4); idx_trips_*_time keep ORDER BY started_at DESC cheap. */
  app.get('/trips', async (req, reply) => {
    const claims = await auth(req);
    const parsed = z.object({
      driver_id: z.string().uuid().optional(),
      vehicle_id: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      status: z.enum(['active', 'ended', 'separation']).optional(),
      limit: z.coerce.number().int().positive().max(200).default(50),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
    const q = parsed.data;
    const driverId = scopeFilter(claims, q.driver_id);
    const trips = await listTrips({ ...q, driver_id: driverId });
    if (claims.role !== 'DRIVER') {
      await audit({ actorId: claims.id, action: 'read_trips', targetUser: driverId ?? null,
                    ip: req.ip, detail: { count: trips.length, filter: q } });
    }
    return { count: trips.length, trips };
  });

  /** GET /trips/status?vehicle_id= OR ?driver_id= — internal live-status API (§1.5). */
  app.get('/trips/status', async (req, reply) => {
    const claims = await auth(req);
    const parsed = z.object({ vehicle_id: z.string().uuid().optional(), driver_id: z.string().uuid().optional() })
      .safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    let vehicleId = parsed.data.vehicle_id;
    if (!vehicleId && parsed.data.driver_id) {
      const { rows } = await pool.query(
        `SELECT vehicle_id FROM driver_vehicle_assignments WHERE driver_id=$1 AND unassigned_at IS NULL LIMIT 1`,
        [parsed.data.driver_id]);
      vehicleId = rows[0]?.vehicle_id;
    }
    if (!vehicleId) return reply.code(404).send({ error: 'no_vehicle_for_driver' });
    if (claims.role === 'DRIVER' && parsed.data.driver_id && parsed.data.driver_id !== claims.sub)
      return reply.code(403).send({ error: 'forbidden_role' });
    const status = await getTripStatusForVehicle(vehicleId);
    return status ?? { state: 'IDLE', vehicle_id: vehicleId, trip: null };
  });

  /** GET /trips/:trip_id — detail: summary + full event timeline + separation incidents. */
  app.get('/trips/:trip_id', async (req, reply) => {
    const claims = await auth(req);
    const parsed = z.object({ trip_id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_trip_id' });
    const detail = await getTripDetail(parsed.data.trip_id);
    if (!detail) return reply.code(404).send({ error: 'trip_not_found' });
    if (claims.role === 'DRIVER' && detail.trip.driver_id !== claims.sub)
      return reply.code(403).send({ error: 'forbidden_role' });
    if (claims.role !== 'DRIVER') {
      await audit({ actorId: claims.id, action: 'read_trip_detail', targetUser: detail.trip.driver_id,
                    ip: req.ip, detail: { trip_id: parsed.data.trip_id } });
    }
    return detail;
  });
}
