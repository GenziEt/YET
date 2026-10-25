import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BatchSchema, ingestLocationBatch, SensorBatchSchema, ingestSensorBatch,
  BatterySampleSchema, ingestBatteryBatch, DiagnosticsSchema, ingestDiagnostics,
} from './service.js';
import { FixQuerySchema, listActiveDrivers, listFixes } from './read_service.js';
import { verifyAccessToken, type TokenClaims } from '../../lib/jwt.js';
import { assertTargetInFleet, forbiddenCrossFleet, getDriverFleet } from '../../lib/tenant.js';
import { assertConsentActive } from '../identity/consent.js';
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

/**
 * Phase 0 collection guard (PDPP §1.7): consent state is checked BEFORE any
 * batch is accepted. assertConsentActive throws 403 `consent_required` when the
 * driver has no un-revoked grant covering the CURRENT policy version — which
 * automatically covers withdrawal (POST /consent/revoke) and policy bumps (a
 * new entry in consent.ts's registry invalidates every older grant). The guard
 * runs on ALL FOUR ingest endpoints: locations, sensors, battery, diagnostics.
 */
async function consentGuard(driverId: string): Promise<void> {
  await assertConsentActive(driverId);
  // Tenant suspension gate (Phase 0, mirrors the login denial in identity):
  // while a fleet is SUSPENDED no data may be collected from its drivers —
  // ingest fails closed with 403 fleet_suspended. ADMIN tokens have no fleet
  // claim and are never denied here. The lookup rides the same users row the
  // consent path already joins, so it adds one indexed PK/FK read per batch.
  const { rows } = await pool.query<{ status: string; fleet_id: string | null }>(
    `SELECT f.status, u.fleet_id
       FROM users u LEFT JOIN fleets f ON f.id = u.fleet_id
      WHERE u.id = $1`, [driverId]);
  if (rows.length === 0) throw Object.assign(new Error('driver_not_found'), { statusCode: 404 });
  const gate = rows[0];
  if (gate?.fleet_id && gate.status !== 'ACTIVE') {
    await audit({ actorId: driverId, action: 'ingest_denied_fleet_suspended', targetUser: driverId,
                  detail: { fleet_id: gate.fleet_id } });
    throw Object.assign(new Error('fleet_suspended'), { statusCode: 403 });
  }
}

/** Reads of personal location data require an explicit role (§1.7). Drivers may read
 *  their own history; FLEET_MANAGER/ADMIN read any driver — and since Phase 0 a
 *  FLEET_MANAGER is confined to their OWN fleet (cross-fleet reads are denied at
 *  this boundary with 403 cross_fleet_denied; covered by negative tests). */
async function readAuth(req: any, targetDriverId: string): Promise<{ id: string; role: string }> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const claims = verifyAccessToken(header.slice(7));
  if (claims.role === 'DRIVER' && claims.sub !== targetDriverId)
    throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
  if (claims.role === 'DRIVER') return { id: claims.sub, role: claims.role };
  if (claims.role === 'FLEET_MANAGER' || claims.role === 'ADMIN') {
    // Tenant layer: FLEET_MANAGER tokens must belong to the target's fleet.
    await assertTargetInFleet(claims, { driverId: targetDriverId });
    return { id: claims.sub, role: claims.role };
  }
  throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
}

/** Any authenticated principal (roster reads need identity for the audit row). */
async function bearerClaims(req: any): Promise<TokenClaims> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  return verifyAccessToken(header.slice(7));
}

export default async function ingestRoutes(app: FastifyInstance) {
  // Per-driver backpressure (§1.10.4): 60 batches/minute -> 429 + Retry-After.
  const limiter = app.rateLimit.bind(app);

  app.post('/ingest/locations', {
    config: { rateLimit: { max: env.INGEST_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = await driverAuth(req);
    await consentGuard(auth.id); // collection guard: no consent ⇒ no ingest (§1.7)
    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_batch', detail: parsed.error.flatten() });

    // Resolve the driver's active vehicle assignment (Identity owns this table;
    // Ingest reads it read-only to stamp rows — acceptable cross-module read in a
    // monolith; becomes an internal API call on extraction).
    const { rows: asg } = await pool.query(
      `SELECT vehicle_id FROM driver_vehicle_assignments
       WHERE driver_id=$1 AND unassigned_at IS NULL LIMIT 1`, [auth.id]);

    const result = await ingestLocationBatch(auth.id, asg[0]?.vehicle_id ?? null, parsed.data, req.log);
    // p95 budget: <=300ms for 100 fixes (§1.9.4). ACK lets client mark records ACKED (§1.8.1).
    return reply.code(200).send({
      batch_id: parsed.data.batch_id,
      accepted: result.accepted,
      already_received: result.already_received,
    });
  });

  /**
   * POST /ingest/sensors — Phase 2 sensor batches (§1.8.5): accelerometer/gyro
   * samples, device-fused turn/harsh events, vibration-gate transitions and the
   * phone-vehicle alignment metadata all arrive here with the SAME offline contract
   * as GPS fixes: UUID batch_id idempotency (§1.8.2), event-time timestamps (§1.8.3),
   * per-driver rate limit (§1.10.4). Trip Engine recompute is triggered on arrival.
   */
  app.post('/ingest/sensors', {
    config: { rateLimit: { max: env.INGEST_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = await driverAuth(req);
    await consentGuard(auth.id); // collection guard (§1.7) — sensors too
    const parsed = SensorBatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_batch', detail: parsed.error.flatten() });

    const { rows: asg } = await pool.query(
      `SELECT vehicle_id FROM driver_vehicle_assignments
       WHERE driver_id=$1 AND unassigned_at IS NULL LIMIT 1`, [auth.id]);
    if (!asg[0]?.vehicle_id) return reply.code(409).send({ error: 'no_vehicle_assignment' });

    try {
      const result = await ingestSensorBatch(auth.id, asg[0].vehicle_id, parsed.data, req.log);
      return reply.code(200).send({
        batch_id: parsed.data.batch_id,
        accepted: result.accepted,
        already_received: result.already_received,
      });
    } catch (err: any) {
      if (err?.code === '23505') { // row-level replay after a partial first attempt
        return reply.code(200).send({ batch_id: parsed.data.batch_id, accepted: 0, already_received: true });
      }
      throw err;
    }
  });

  /**
   * POST /ingest/battery — Phase 4 pilot telemetry: battery % at trip start/end,
   * reported by the app through the same Offline Contract envelope (batch_id
   * idempotency §1.8.2, event times §1.8.3, per-driver rate limit §1.10.4).
   */
  app.post('/ingest/battery', {
    config: { rateLimit: { max: env.INGEST_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = await driverAuth(req);
    await consentGuard(auth.id); // collection guard (§1.7) — battery telemetry too
    const parsed = BatterySampleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_batch', detail: parsed.error.flatten() });
    const { rows: asg } = await pool.query(
      `SELECT vehicle_id FROM driver_vehicle_assignments
       WHERE driver_id=$1 AND unassigned_at IS NULL LIMIT 1`, [auth.id]);
    try {
      const result = await ingestBatteryBatch(auth.id, asg[0]?.vehicle_id ?? null, parsed.data);
      return reply.code(200).send({ batch_id: parsed.data.batch_id, accepted: result.accepted,
                                    already_received: result.already_received });
    } catch (err: any) {
      if (err?.statusCode === 409) return reply.code(409).send({ error: 'no_vehicle_assignment' });
      throw err;
    }
  });

  /**
   * POST /ingest/diagnostics — one-tap in-app feedback (§Phase 4 deliverable):
   * "GPS not working"/"app draining battery" + diagnostic payload (battery level,
   * GPS accuracy, last fix age, network type, pending sync count).
   */
  app.post('/ingest/diagnostics', {
    config: { rateLimit: { max: env.INGEST_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = await driverAuth(req);
    await consentGuard(auth.id); // collection guard (§1.7) — diagnostics too
    const parsed = DiagnosticsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload', detail: parsed.error.flatten() });
    const { rows: asg } = await pool.query(
      `SELECT vehicle_id FROM driver_vehicle_assignments
       WHERE driver_id=$1 AND unassigned_at IS NULL LIMIT 1`, [auth.id]);
    const result = await ingestDiagnostics(auth.id, asg[0]?.vehicle_id ?? null, parsed.data);
    return reply.code(result.already_received ? 200 : 201).send({
      batch_id: parsed.data.batch_id, accepted: result.accepted,
      already_received: result.already_received,
    });
  });

  /** GET /ingest/drivers?since=ISO — roster for the dashboard driver selector.
   *  Phase 5 (C): this returns names of real people, so it now requires a token
   *  and lands a read_roster audit row like every other personal-data read
   *  (PDPP §1.7: "Ingest module logs all access"). */
  app.get('/ingest/drivers', async (req) => {
    const claims = await bearerClaims(req);
    const q = z.object({ since: z.string().datetime().optional() }).parse(req.query);
    const since = q.since ?? new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    // Tenant scoping (Phase 0): FLEET_MANAGER sees only their fleet's roster;
    // ADMIN sees all. The roster names real people, so it is a personal-data
    // read path and must not leak across tenants.
    const fleetId = claims.role === 'ADMIN' ? undefined : (claims.fleetId ?? forbiddenCrossFleet());
    const drivers = await listActiveDrivers(since, fleetId);
    await audit({ actorId: claims.sub, action: 'read_roster', targetUser: null,
                  ip: req.ip, detail: { since, count: drivers.length, fleet_scoped: !!fleetId } });
    return { drivers };
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

  /**
   * DELETE /driver/:id/location-history — PDPP §1.7 erasure request (§Master
   * "Data erasure endpoint", Phase 5 deliverable C). Semantics:
   *   - caller must be the DRIVER (self-service erasure) or an ADMIN;
   *   - raw location_fixes older than ERASURE_WINDOW_DAYS (default 30) are
   *     deleted outright; the remaining recent window is DOWNSAMPLED to every
   *     Nth fix (retention_kernel selector — same stable phase as the nightly
   *     job, so results are identical however often this is called);
   *   - trip aggregates + trip_events are RETAINED by design (the spec says
   *     "anonymizes location fixes ... retaining trip aggregates only" — the
   *     aggregates carry no coordinates beyond stop snapshots owned by Trip
   *     Engine; full account deletion is Identity's separate path);
   *   - ingest_batches provenance rows for purged fixes are removed so no
   *     orphaned batch metadata survives;
   *   - completion lands in audit_log BEFORE the 200 — the driver gets a
   *     confirmable receipt ("backend confirms completion", §Gate).
   */
  app.delete('/driver/:id/location-history', async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_driver_id' });
    const claims = await bearerClaims(req);
    if (claims.role === 'DRIVER' && claims.sub !== params.data.id)
      return reply.code(403).send({ error: 'forbidden_role' });
    if (claims.role !== 'DRIVER' && claims.role !== 'ADMIN')
      return reply.code(403).send({ error: 'forbidden_role' });

    const horizonDays = env.ERASURE_WINDOW_DAYS;
    const keepEveryN = env.RETENTION_KEEP_EVERY_N;
    const driverId = params.data.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock-free set-based pass mirroring retention_kernel's ordering contract:
      // row_number over (fix_timestamp, fix_id) per driver, delete non-kept rows
      // strictly older than the horizon. Keeps index 0 of the old range (anchor).
      const { rows: counts } = await client.query(
        `WITH old AS (
           SELECT fix_id, fix_timestamp,
                  row_number() OVER (PARTITION BY driver_id
                                     ORDER BY fix_timestamp ASC, fix_id ASC) AS rn
             FROM location_fixes
            WHERE driver_id = $1 AND fix_timestamp < now() - make_interval(days => $2)
         ), doomed AS (
           DELETE FROM location_fixes lf
            USING old o
            WHERE lf.fix_id = o.fix_id AND lf.fix_timestamp = o.fix_timestamp
              AND (o.rn - 1) % $3 <> 0
         )
         SELECT (SELECT count(*) FROM old) AS scanned_old,
                (SELECT count(*) FROM doomed) AS deleted`,
        [driverId, horizonDays, keepEveryN]);
      const deleted = Number(counts[0]?.deleted ?? 0);
      const scannedOld = Number(counts[0]?.scanned_old ?? 0);
      // Purge batch provenance for batches that now hold zero fixes (minimize
      // residue; recent-window batches keep their rows and stay referenced).
      const { rows: purged } = await client.query(
        `DELETE FROM ingest_batches ib
           WHERE ib.driver_id = $1
             AND NOT EXISTS (SELECT 1 FROM location_fixes lf WHERE lf.batch_id = ib.batch_id)
         RETURNING ib.batch_id`, [driverId]);
      await client.query(
        `INSERT INTO audit_log (actor_id, action, target_user, ip, detail)
         VALUES ($1, 'erasure_location_history', $2, $3, $4)`,
        [claims.sub, driverId, req.ip,
         JSON.stringify({ horizon_days: horizonDays, keep_every_n: keepEveryN,
                          scanned_old: scannedOld, deleted_rows: deleted,
                          purged_batches: purged.length })]);
      await client.query('COMMIT');
      return reply.code(200).send({
        driver_id: driverId,
        completed_at: new Date().toISOString(),
        deleted_raw_fixes_older_than_days: horizonDays,
        downsample_keep_every_n: keepEveryN,
        scanned_old_fixes: scannedOld,
        deleted_rows: deleted,
        purged_batches: purged.length,
        retained: ['trip_aggregates', 'trip_events'],
        audit_action: 'erasure_location_history',
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
