import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BatchSchema, ingestLocationBatch } from './service.js';
import { FixQuerySchema, listActiveDrivers, listFixes } from './read_service.js';
import { verifyAccessToken } from '../../lib/jwt.js';
import { pool } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';

async function driverAuth(req: any): Promise<{ id: string; role: string }> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const claims = verifyAccessToken(header.slice(7));
  if (claims.role !== 'DRIVER' && claims.role !== 'ADMIN')
    throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
  return { id: claims.sub, role: claims.role };
}

/** Reads of personal location data require an explicit role (§1.7). Drivers may read
 *  their own history; FLEET_MANAGER/ADMIN read any driver (assignment check lands
 *  with Identity's fleet-scoping in Phase 2 — audit trail covers it meanwhile). */
async function readAuth(req: any, targetDriverId: string): Promise<{ id: string; role: string }> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const claims = verifyAccessToken(header.slice(7));
  if (claims.role === 'DRIVER' && claims.sub !== targetDriverId)
    throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
  if (claims.role === 'DRIVER' || claims.role === 'FLEET_MANAGER' || claims.role === 'ADMIN')
    return { id: claims.sub, role: claims.role };
  throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
}

export default async function ingestRoutes(app: FastifyInstance) {
  // Per-driver backpressure (§1.10.4): 60 batches/minute -> 429 + Retry-After.
  const limiter = app.rateLimit.bind(app);

  app.post('/ingest/locations', {
    config: { rateLimit: { max: env.INGEST_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = await driverAuth(req);
    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_batch', detail: parsed.error.flatten() });

    // Resolve the driver's active vehicle assignment (Identity owns this table;
    // Ingest reads it read-only to stamp rows — acceptable cross-module read in a
    // monolith; becomes an internal API call on extraction).
    const { rows: asg } = await pool.query(
      `SELECT vehicle_id FROM driver_vehicle_assignments
       WHERE driver_id=$1 AND unassigned_at IS NULL LIMIT 1`, [auth.id]);

    const result = await ingestLocationBatch(auth.id, asg[0]?.vehicle_id ?? null, parsed.data);
    // p95 budget: <=300ms for 100 fixes (§1.9.4). ACK lets client mark records ACKED (§1.8.1).
    return reply.code(200).send({
      batch_id: parsed.data.batch_id,
      accepted: result.accepted,
      already_received: result.already_received,
    });
  });

  /** GET /ingest/drivers?since=ISO — roster for the dashboard driver selector. */
  app.get('/ingest/drivers', async (req) => {
    const q = z.object({ since: z.string().datetime().optional() }).parse(req.query);
    const since = q.since ?? new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    return { drivers: await listActiveDrivers(since) };
  });

  /**
   * GET /ingest/fixes?driver_id=&from=&to= — raw-fix history for the dashboard's
   * table + polyline view (Phase 1 deliverable). Ordered by EVENT time (§1.8.3),
   * paginated via limit. Every read is audited (PDPP §1.7 breach-readiness):
   * "Ingest module logs all access."
   */
  app.get('/ingest/fixes', async (req, reply) => {
    const parsed = FixQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
    const auth = await readAuth(req, parsed.data.driver_id);
    const fixes = await listFixes(parsed.data);
    await audit({ actorId: auth.id, action: 'read_locations', targetUser: parsed.data.driver_id,
                  ip: req.ip, detail: { from: parsed.data.from, to: parsed.data.to, count: fixes.length } });
    return { driver_id: parsed.data.driver_id, count: fixes.length, fixes };
  });
}
