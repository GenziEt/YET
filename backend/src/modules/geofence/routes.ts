import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyAccessToken, type TokenClaims } from '../../lib/jwt.js';
import { audit } from '../../lib/audit.js';
import { pool } from '../../db/pool.js';
import {
  createGeofence, updateGeofence, deleteGeofence, getGeofence, listGeofences,
  vehicleGeofenceState, GeofenceValidationError,
} from './service.js';

/**
 * Module 4 — Geofence & Route HTTP surface (Phase 3).
 *   GET    /geofences                     → active zones (any authenticated role)
 *   GET    /geofences/state?vehicle_id=   → inside/outside vs latest fix (dashboard layer)
 *   GET    /geofences/:id                 → one zone incl. ring for redraw
 *   POST   /geofences                     → FLEET_MANAGER / ADMIN only
 *   PUT    /geofences/:id                 → FLEET_MANAGER / ADMIN only
 *   DELETE /geofences/:id                 → soft-deactivate, FLEET_MANAGER / ADMIN only
 */

async function auth(req: any): Promise<TokenClaims> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  return verifyAccessToken(header.slice(7));
}

const WRITE_ROLES: TokenClaims['role'][] = ['FLEET_MANAGER', 'ADMIN'];
function requireWrite(claims: TokenClaims) {
  if (!WRITE_ROLES.includes(claims.role))
    throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
}

const CATEGORY = z.enum(['WAREHOUSE', 'CUSTOMER_SITE', 'RESTRICTED_ZONE', 'DEPOT', 'OTHER']);
const CircleBody = z.object({
  kind: z.literal('CIRCLE'),
  name: z.string().min(1).max(200),
  category: CATEGORY.default('OTHER'),
  center: z.object({ lat: z.number(), lng: z.number() }),
  radius_m: z.number().positive().max(100_000),
});
const PolygonBody = z.object({
  kind: z.literal('POLYGON'),
  name: z.string().min(1).max(200),
  category: CATEGORY.default('OTHER'),
  ring: z.array(z.tuple([z.number(), z.number()])).min(4).max(500), // [lat,lng][] closed
});
const UpdateBody = z.union([CircleBody, PolygonBody]).or(
  z.object({ name: z.string().min(1).max(200).optional(),
             category: CATEGORY.optional(),
             active: z.boolean().optional() }).partial());

export default async function geofenceRoutes(app: FastifyInstance) {
  /** List active geofences (+ optionally inactive for managers). */
  app.get('/geofences', async (req, reply) => {
    const claims = await auth(req);
    const parsed = z.object({ include_inactive: z.enum(['true', 'false']).optional() })
      .safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const activeOnly = parsed.data.include_inactive !== 'true';
    const geofences = await listGeofences({ active_only: activeOnly });
    return { count: geofences.length, geofences };
  });

  /** Inside/outside state of a vehicle's latest fix — dashboard layer coloring. */
  app.get('/geofences/state', async (req, reply) => {
    const claims = await auth(req);
    const parsed = z.object({ vehicle_id: z.string().uuid() }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    if (claims.role === 'DRIVER') {
      // Drivers may only query their own assigned vehicle (§1.7 minimization).
      const { rows } = await pool.query(
        `SELECT vehicle_id FROM driver_vehicle_assignments
          WHERE driver_id=$1 AND unassigned_at IS NULL LIMIT 1`, [claims.sub]);
      if (rows[0]?.vehicle_id !== parsed.data.vehicle_id)
        return reply.code(403).send({ error: 'forbidden_role' });
    }
    return vehicleGeofenceState(parsed.data.vehicle_id);
  });

  /** Single geofence detail (ring geometry for the drawing tool to re-edit). */
  app.get('/geofences/:geofence_id', async (req, reply) => {
    await auth(req);
    const parsed = z.object({ geofence_id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_geofence_id' });
    const g = await getGeofence(parsed.data.geofence_id);
    if (!g) return reply.code(404).send({ error: 'geofence_not_found' });
    return g;
  });

  /** Create — fleet manager/admin only (drivers never define zones). */
  app.post('/geofences', async (req, reply) => {
    const claims = await auth(req);
    requireWrite(claims);
    const parsed = z.union([CircleBody, PolygonBody]).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', detail: parsed.error.flatten() });
    try {
      const created = await createGeofence(claims.sub, parsed.data);
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof GeofenceValidationError)
        return reply.code(400).send({ error: 'geofence_invalid', detail: err.detail });
      throw err;
    }
  });

  /** Update (geometry or metadata; partial merge allowed). */
  app.put('/geofences/:geofence_id', async (req, reply) => {
    const claims = await auth(req);
    requireWrite(claims);
    const parsedParams = z.object({ geofence_id: z.string().uuid() }).safeParse(req.params);
    if (!parsedParams.success) return reply.code(400).send({ error: 'invalid_geofence_id' });
    const parsedBody = UpdateBody.safeParse(req.body);
    if (!parsedBody.success) return reply.code(400).send({ error: 'invalid_body', detail: parsedBody.error.flatten() });
    try {
      return await updateGeofence(claims.sub, parsedParams.data.geofence_id, parsedBody.data);
    } catch (err) {
      if (err instanceof GeofenceValidationError)
        return reply.code(400).send({ error: 'geofence_invalid', detail: err.detail });
      const status = (err as any)?.statusCode;
      if (status === 404) return reply.code(404).send({ error: 'geofence_not_found' });
      throw err;
    }
  });

  /** Soft-delete (deactivate): history stays interpretable (§1.7). */
  app.delete('/geofences/:geofence_id', async (req, reply) => {
    const claims = await auth(req);
    requireWrite(claims);
    const parsed = z.object({ geofence_id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_geofence_id' });
    const done = await deleteGeofence(claims.sub, parsed.data.geofence_id);
    if (!done) return reply.code(404).send({ error: 'geofence_not_found' });
    await audit({ actorId: claims.sub, action: 'geofence_delete', ip: req.ip,
                  detail: { geofence_id: parsed.data.geofence_id } });
    return { deleted: true, mode: 'deactivated' };
  });
}
