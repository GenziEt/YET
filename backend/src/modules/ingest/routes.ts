import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BatchSchema, ingestLocationBatch } from './service.js';
import { verifyAccessToken } from '../../lib/jwt.js';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';

async function driverAuth(req: any): Promise<{ id: string; role: string }> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const claims = verifyAccessToken(header.slice(7));
  if (claims.role !== 'DRIVER' && claims.role !== 'ADMIN')
    throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
  return { id: claims.sub, role: claims.role };
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
}
