import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyAccessToken, type TokenClaims } from '../../lib/jwt.js';
import { audit } from '../../lib/audit.js';
import { PilotQuerySchema, getPilotSummary } from './pilot_service.js';

/**
 * Module 6 (Reporting) HTTP surface — Phase 4 pilot dashboard reads.
 * Read-only (§1.5): no writes, no primary tables. Fleet managers/admins only;
 * every read of aggregated personal data is audited (PDPP §1.7 breach-readiness).
 */

async function managerAuth(req: any): Promise<TokenClaims> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const claims = verifyAccessToken(header.slice(7));
  if (claims.role !== 'FLEET_MANAGER' && claims.role !== 'ADMIN')
    throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
  return claims;
}

export default async function reportingRoutes(app: FastifyInstance) {
  /** GET /reports/pilot?from=&to=&driver_id= — battery drain, upload latency,
   *  separation counts, sync backlog, offline-reconstruction audit, feedback queue. */
  app.get('/reports/pilot', async (req, reply) => {
    const claims = await managerAuth(req);
    const parsed = PilotQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
    const summary = await getPilotSummary(parsed.data);
    await audit({ actorId: claims.sub, action: 'read_pilot_report', targetUser: parsed.data.driver_id ?? null,
                  ip: req.ip, detail: { from: parsed.data.from, to: parsed.data.to } });
    return summary;
  });
}
