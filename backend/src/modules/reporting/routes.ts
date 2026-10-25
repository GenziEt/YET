import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyAccessToken, type TokenClaims } from '../../lib/jwt.js';
import { audit } from '../../lib/audit.js';
import { PilotQuerySchema, getPilotSummary } from './pilot_service.js';
import { getTripReport, getSeparationIncidents, getFleetOverview } from './service.js';
import { FLEET_STATE_CACHE_KEY } from './kernel.js';
import { cacheDel } from '../../lib/redis.js';
import { assertTargetInFleet, deny, isDenial, scopeFleetId } from '../../lib/tenant.js';

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

/** Run a route body whose guards may throw machine-readable denials; translate
 *  them into direct {error:<code>} replies (see lib/tenant.ts deny()). */
async function withDenials(reply: any, fn: () => Promise<any>) {
  try {
    return await fn();
  } catch (e) {
    if (isDenial(e)) return deny(reply, e.message);
    throw e;
  }
}

export default async function reportingRoutes(app: FastifyInstance) {
  /** GET /reports/pilot?from=&to=&driver_id= — battery drain, upload latency,
   *  separation counts, sync backlog, offline-reconstruction audit, feedback queue. */
  app.get('/reports/pilot', async (req, reply) => {
    return withDenials(reply, async () => {
      const claims = await managerAuth(req);
      const parsed = PilotQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
      // Tenant boundary (Phase 0): a named driver must be in the caller's fleet;
      // aggregate pilot reads are confined to the caller's fleet unless ADMIN.
      if (parsed.data.driver_id) await assertTargetInFleet(claims, { driverId: parsed.data.driver_id });
      const summary = await getPilotSummary({ ...parsed.data, fleet_id: scopeFleetId(claims) });
      await audit({ actorId: claims.sub, action: 'read_pilot_report', targetUser: parsed.data.driver_id ?? null,
                    ip: req.ip, detail: { from: parsed.data.from, to: parsed.data.to } });
      return summary;
    });
  });

  /* --------------------- Phase 5: trip / separation / fleet-state --------------------- */

  const WindowSchema = z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    driver_id: z.string().uuid().optional(),
  });

  /** GET /reports/trips?from=&to=&driver_id= — weekly trip report (§1.9.4 p95
   *  ≤500 ms for one week/one driver). Replica-backed read, audited. */
  app.get('/reports/trips', async (req, reply) => {
    return withDenials(reply, async () => {
      const claims = await managerAuth(req);
      const parsed = WindowSchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
      if (parsed.data.driver_id) await assertTargetInFleet(claims, { driverId: parsed.data.driver_id });
      const report = await getTripReport({ ...parsed.data, fleet_id: scopeFleetId(claims) });
      await audit({ actorId: claims.sub, action: 'read_trip_report', targetUser: parsed.data.driver_id ?? null,
                    ip: req.ip, detail: { from: parsed.data.from, to: parsed.data.to, trips: report.trips.length } });
      return report;
    });
  });

  /** GET /reports/separations?from=&to=&driver_id=&open_only= — §1.4 incident
   *  history with honest last-known-location labeling. Audited like every read
   *  of personal data. */
  app.get('/reports/separations', async (req, reply) => {
    return withDenials(reply, async () => {
      const claims = await managerAuth(req);
      const parsed = WindowSchema.extend({ open_only: z.coerce.boolean().default(false) }).safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
      if (parsed.data.driver_id) await assertTargetInFleet(claims, { driverId: parsed.data.driver_id });
      const result = await getSeparationIncidents({ ...parsed.data, fleet_id: scopeFleetId(claims) });
      await audit({ actorId: claims.sub, action: 'read_separation_report', targetUser: parsed.data.driver_id ?? null,
                    ip: req.ip, detail: { from: parsed.data.from, to: parsed.data.to, count: result.count } });
      return result;
    });
  });

  /** GET /reports/fleet-state?refresh=1 — live-map feed for the dashboard.
   *  Redis fleet:state TTL 30s absorbs poll storms (§1.10.2); `refresh=1` lets a
   *  manual reload bust the cache once (ops/testing convenience, still audited-
   *  free because it aggregates no new personal reads beyond the cached shape).
   *  Drivers are rejected here — this is a fleet-wide view (§1.7 minimization).
   *  Phase 0 tenant scoping: FLEET_MANAGER sees ONLY their own fleet (per-fleet
   *  cache key + SQL filter); ADMIN sees the whole platform. */
  app.get('/reports/fleet-state', async (req, reply) => {
    return withDenials(reply, async () => {
      const claims = await managerAuth(req);
      const q = z.object({ refresh: z.coerce.boolean().default(false) }).parse(req.query);
      const fleetId = scopeFleetId(claims); // fail-closed for tenant tokens lacking a fleet claim
      const cacheKey = fleetId ? `${FLEET_STATE_CACHE_KEY}:${fleetId}` : FLEET_STATE_CACHE_KEY;
      if (q.refresh) await cacheDel(cacheKey);
      return getFleetOverview({ fleetId });
    });
  });
}
