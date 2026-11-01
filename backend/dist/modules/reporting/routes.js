import { z } from 'zod';
import { verifyAccessToken } from '../../lib/jwt.js';
import { audit } from '../../lib/audit.js';
import { pool } from '../../db/pool.js';
import { PilotQuerySchema, getPilotSummary } from './pilot_service.js';
import { getTripReport, getSeparationIncidents, getFleetOverview } from './service.js';
import { FLEET_STATE_CACHE_KEY } from './kernel.js';
import { cacheDel, cacheDelMany, cacheKeysByPrefix } from '../../lib/redis.js';
import { env, isProd } from '../../config/env.js';
import { assertTargetInFleet, deny, isDenial, scopeFleetId } from '../../lib/tenant.js';
/**
 * Module 6 (Reporting) HTTP surface — Phase 4 pilot dashboard reads.
 * Read-only (§1.5): no writes, no primary tables. Fleet managers/admins only;
 * every read of aggregated personal data is audited (PDPP §1.7 breach-readiness).
 */
async function managerAuth(req) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    const claims = verifyAccessToken(header.slice(7));
    if (claims.role !== 'FLEET_MANAGER' && claims.role !== 'ADMIN')
        throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
    return claims;
}
/** Run a route body whose guards may throw machine-readable denials; translate
 *  them into direct {error:<code>} replies (see lib/tenant.ts deny()). */
async function withDenials(reply, fn) {
    try {
        return await fn();
    }
    catch (e) {
        if (isDenial(e))
            return deny(reply, e.message);
        throw e;
    }
}
/* ------------------------- CSV export (§Master Phase 5: "Reporting endpoints …
   complete with fleet scoping and CSV export") -------------------------
   `?format=csv` on /reports/trips and /reports/separations serializes the SAME
   fleet-scoped, audited result as an RFC-4180-flavored CSV (comma, CRLF, quotes
   doubled). Authorization, tenant scoping, validation and audit are identical
   to the JSON path — the format parameter never bypasses a guard. */
const FormatSchema = z.object({ format: z.enum(['json', 'csv']).default('json') });
export function toCsv(rows, columns) {
    const esc = (v) => {
        if (v === null || v === undefined)
            return '';
        let s;
        if (typeof v === 'object')
            s = JSON.stringify(v);
        else
            s = String(v);
        if (/[",\r\n]/.test(s))
            s = `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    const lines = [columns.join(',')];
    for (const r of rows)
        lines.push(columns.map((c) => esc(r[c])).join(','));
    return lines.join('\r\n') + '\r\n';
}
function csvReply(req, reply, body, filename) {
    req.log.info({ filename }, 'csv export');
    return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(body);
}
export default async function reportingRoutes(app) {
    /** GET /reports/pilot?from=&to=&driver_id= — battery drain, upload latency,
     *  separation counts, sync backlog, offline-reconstruction audit, feedback queue. */
    app.get('/reports/pilot', async (req, reply) => {
        return withDenials(reply, async () => {
            const claims = await managerAuth(req);
            const parsed = PilotQuerySchema.safeParse(req.query);
            if (!parsed.success)
                return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
            // Tenant boundary (Phase 0): a named driver must be in the caller's fleet;
            // aggregate pilot reads are confined to the caller's fleet unless ADMIN.
            if (parsed.data.driver_id)
                await assertTargetInFleet(claims, { driverId: parsed.data.driver_id });
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
        format: z.enum(['json', 'csv']).default('json'),
    });
    const TRIP_CSV_COLUMNS = [
        'trip_id', 'driver_id', 'plate_number', 'started_at', 'ended_at', 'state',
        'distance_m', 'moving_duration_s', 'stopped_duration_s', 'turn_count', 'harsh_event_count',
    ];
    const SEPARATION_CSV_COLUMNS = [
        'separation_id', 'trip_id', 'vehicle_id', 'driver_id', 'driver_name', 'plate_number',
        'status', 'separated_at', 'returned_at', 'duration_min', 'truck_stop_lat', 'truck_stop_lng',
        'distance_m', 'notified_fleet_manager',
    ];
    /** GET /reports/trips?from=&to=&driver_id= — weekly trip report (§1.9.4 p95
     *  ≤500 ms for one week/one driver). Replica-backed read, audited. */
    app.get('/reports/trips', async (req, reply) => {
        return withDenials(reply, async () => {
            const claims = await managerAuth(req);
            const parsed = WindowSchema.safeParse(req.query);
            if (!parsed.success)
                return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
            if (parsed.data.driver_id)
                await assertTargetInFleet(claims, { driverId: parsed.data.driver_id });
            const report = await getTripReport({ ...parsed.data, fleet_id: scopeFleetId(claims) });
            await audit({ actorId: claims.sub, action: 'read_trip_report', targetUser: parsed.data.driver_id ?? null,
                ip: req.ip, detail: { from: parsed.data.from, to: parsed.data.to, trips: report.trips.length,
                    format: parsed.data.format } });
            if (parsed.data.format === 'csv') {
                return csvReply(req, reply, toCsv(report.trips, [...TRIP_CSV_COLUMNS]), `trips_${parsed.data.from.slice(0, 10)}_to_${parsed.data.to.slice(0, 10)}.csv`);
            }
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
            if (!parsed.success)
                return reply.code(400).send({ error: 'invalid_query', detail: parsed.error.flatten() });
            if (parsed.data.driver_id)
                await assertTargetInFleet(claims, { driverId: parsed.data.driver_id });
            const result = await getSeparationIncidents({ ...parsed.data, fleet_id: scopeFleetId(claims) });
            await audit({ actorId: claims.sub, action: 'read_separation_report', targetUser: parsed.data.driver_id ?? null,
                ip: req.ip, detail: { from: parsed.data.from, to: parsed.data.to, count: result.count,
                    format: parsed.data.format } });
            if (parsed.data.format === 'csv') {
                return csvReply(req, reply, toCsv(result.incidents, [...SEPARATION_CSV_COLUMNS]), `separations_${parsed.data.from.slice(0, 10)}_to_${parsed.data.to.slice(0, 10)}.csv`);
            }
            return result;
        });
    });
    /** POST /reports/retention/run — §1.10.6 90-day downsampling pass, in-process.
     *
     *  The deployment schedule (infra/cron/yet-retention → docker-compose
     *  `retention` service) runs scripts/retention.mjs nightly; this endpoint is
     *  the OPERATOR-triggerable equivalent of that same job so retention can be
     *  exercised and TESTED against a running backend ("Data retention job
     *  (90-day downsampling) scheduled and tested", §Master Phase 5 scalability
     *  gate). It executes the identical set-based SQL as scripts/retention.mjs
     *  (same ordering + phase contract as retention_kernel.selectDownsample),
     *  writes its audit row inside the SAME transaction as the deletes, and is
     *  ADMIN-only. Mounted only when NODE_ENV !== 'production' — the same
     *  discipline as /notifications/sweep/run: an operator-triggerable bulk
     *  DELETE over personal-data tables must never face the open internet;
     *  production cadence belongs to the scheduled container. */
    if (!isProd) {
        app.post('/reports/retention/run', async (req, reply) => {
            const header = req.headers.authorization;
            if (!header?.startsWith('Bearer '))
                return reply.code(401).send({ error: 'unauthorized' });
            let claims;
            try {
                claims = verifyAccessToken(header.slice(7));
            }
            catch {
                return reply.code(401).send({ error: 'unauthorized' });
            }
            if (claims.role !== 'ADMIN')
                return reply.code(403).send({ error: 'forbidden_role' });
            const parsedB = z.object({
                age_days: z.coerce.number().int().positive().default(env.RETENTION_AGE_DAYS),
                keep_every_n: z.coerce.number().int().min(2).default(env.RETENTION_KEEP_EVERY_N),
            }).safeParse(req.body ?? {});
            if (!parsedB.success)
                return reply.code(400).send({ error: 'invalid_body', detail: parsedB.error.flatten() });
            const { age_days: ageDays, keep_every_n: keepEveryN } = parsedB.data;
            // Same partition as scripts/retention.mjs and retention_kernel: per driver,
            // row_number over (fix_timestamp, fix_id), KEEP phase (rn-1)%N==0, DELETE
            // the rest, strictly older than the cutoff. Idempotent: re-running
            // immediately deletes nothing new (survivors renumber onto kept phases).
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const { rows: counts } = await client.query(`WITH old AS (
             SELECT lf.driver_id, lf.fix_id, lf.fix_timestamp,
                    row_number() OVER (PARTITION BY lf.driver_id
                                       ORDER BY lf.fix_timestamp ASC, lf.fix_id ASC) AS rn
               FROM location_fixes lf
              WHERE lf.fix_timestamp < now() - make_interval(days => $1)
           ), doomed AS (
             DELETE FROM location_fixes lf
              USING old o
             WHERE lf.driver_id = o.driver_id
               AND lf.fix_id = o.fix_id
               AND lf.fix_timestamp = o.fix_timestamp
               AND (o.rn - 1) % $2 <> 0
           )
           SELECT (SELECT count(*) FROM old) AS scanned_old,
                  (SELECT count(*) FROM doomed) AS deleted`, [ageDays, keepEveryN]);
                const scannedOld = Number(counts[0]?.scanned_old ?? 0);
                const deleted = Number(counts[0]?.deleted ?? 0);
                // Batch provenance with zero surviving fixes is residue — purge it too
                // (mirrors the erasure path; recent-window batches stay referenced).
                const { rows: purged } = await client.query(`DELETE FROM ingest_batches ib
            WHERE NOT EXISTS (SELECT 1 FROM location_fixes lf WHERE lf.batch_id = ib.batch_id)
            RETURNING ib.batch_id`);
                await client.query(`INSERT INTO audit_log (actor_id, action, target_user, ip, detail)
           VALUES ($1, 'retention_downsample', NULL, $2, $3)`, [claims.sub, req.ip, JSON.stringify({
                        age_days: ageDays, keep_every_n: keepEveryN,
                        scanned_old: scannedOld, deleted_rows: deleted, purged_batches: purged.length,
                        trigger: 'api',
                    })]);
                await client.query('COMMIT');
                // Cached fleet-state embeds latest-fix ages; after bulk pruning, bust it
                // so no aggregate references pruned rows inside its TTL window.
                await cacheDelMany(await cacheKeysByPrefix(FLEET_STATE_CACHE_KEY));
                return reply.code(200).send({
                    completed_at: new Date().toISOString(),
                    age_days: ageDays, keep_every_n: keepEveryN,
                    scanned_old_fixes: scannedOld, deleted_rows: deleted, purged_batches: purged.length,
                    retained: ['trip_aggregates', 'trip_events', 'geofence_crossings', 'separation_incidents', 'notification_log'],
                    audit_action: 'retention_downsample',
                });
            }
            catch (err) {
                await client.query('ROLLBACK').catch(() => { });
                throw err;
            }
            finally {
                client.release();
            }
        });
    }
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
            // safeParse + inline 400: deterministic validation errors independent of
            // plugin-level error-handler ordering (see identity/routes.ts rationale).
            const parsedQ = z.object({ refresh: z.coerce.boolean().default(false) }).safeParse(req.query);
            if (!parsedQ.success)
                return reply.code(400).send({ error: 'validation_failed', detail: parsedQ.error.flatten() });
            const q = parsedQ.data;
            const fleetId = scopeFleetId(claims); // fail-closed for tenant tokens lacking a fleet claim
            const cacheKey = fleetId ? `${FLEET_STATE_CACHE_KEY}:${fleetId}` : FLEET_STATE_CACHE_KEY;
            if (q.refresh)
                await cacheDel(cacheKey);
            return getFleetOverview({ fleetId });
        });
    });
}
//# sourceMappingURL=routes.js.map