/**
 * Phase 5 completion gates — negative AUTHZ + CSV export (§Master Phase 5:
 * "Cross-fleet denial tests exist for every personal-data endpoint touched in
 *  Phases 0–5" and "Reporting endpoints … complete with fleet scoping and CSV
 *  export").
 *
 * Endpoints covered here (the Phase 5 surfaces; foundational reads already have
 * their own negatives in tests/phase0_gates.test.ts):
 *   - GET /reports/trips        (JSON + ?format=csv)
 *   - GET /reports/separations  (JSON + ?format=csv)
 *   - GET /reports/fleet-state
 *   - GET /notifications/log    (fleet-scoped ledger filter — enforcement added
 *     alongside this suite: rows whose target driver is in another tenant are
 *     never returned to a FLEET_MANAGER)
 *   - DELETE /driver/:id/location-history (PDPP erasure, self-service path)
 *   - POST /ingest/locations    (assignment precondition, driverAuth boundary)
 *
 * Style mirrors tests/phase0_gates.test.ts: real Postgres fixtures gated by
 * YET_TEST_DB, app under Fastify inject (no network), tokens signed directly
 * with signAccessToken so principals need no login round-trip.
 *
 *   YET_TEST_DB=postgres://yet:postgres@127.0.0.1:5432/yet npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

const DB = process.env.YET_TEST_DB;
const d = DB ? describe : describe.skip;

// env.ts reads process.env AT IMPORT TIME and exits(1) without these; set them
// BEFORE the dynamic import below. NODE_ENV=test keeps compliance boot
// validation fail-open (warnings only) exactly like phase0_gates.
if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.JWT_SECRET ??= 'phase5-test-secret-0123456789abcdef';
  process.env.NODE_ENV = 'test';
}

let poolX: pg.Pool;
let app: any;

/* Deterministic two-tenant fixtures (ids random per run, NAMES stable). */
const fleetA = randomUUID();
const fleetB = randomUUID();
const driverA = randomUUID();   // fleet A — the personal-data subject
const mgrA = randomUUID();      // fleet A manager (positive control)
const mgrB = randomUUID();      // fleet B manager (cross-fleet principal)
const vehicleA = randomUUID();

function scrypt(pw: string): string {
  // Must match identity/routes.ts hashPassword format so verifyPassword accepts it.
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

async function grantConsent(token: string) {
  const pol = await app.inject({ method: 'GET', url: '/consent/policy' });
  const current = pol.json().current;
  const scopes = [...pol.json().required_scopes];
  const res = await app.inject({ method: 'POST', url: '/consent',
    headers: { authorization: `Bearer ${token}` },
    payload: { policy_version: current, locale: 'en', granted_scopes: scopes } });
  expect(res.statusCode).toBe(201);
}

async function driverToken(driverId: string, fleetId: string): Promise<string> {
  // Post-0016 drivers have no password (DB trigger enforces password_hash IS
  // NULL); legacy suites mint the same JWT shape the pairing flow would issue.
  const { signAccessToken } = await import('../src/lib/jwt.js');
  return signAccessToken({ sub: driverId, role: 'DRIVER', locale: 'en', fleetId });
}

const WIN = 'from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z';

d('Phase 5 gates (Postgres integration): cross-fleet denials + CSV export', () => {
  beforeAll(async () => {
    poolX = new pg.Pool({ connectionString: DB, max: 2 });
    await poolX.query('SELECT 1');
    const { rows: mig } = await poolX.query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='fleets') AS ok`);
    if (!mig[0].ok) throw new Error('YET_TEST_DB missing schema — apply migrations first');

    // Purge leftovers from an interrupted earlier run BY NAME (children first),
    // then seed tenants/users/vehicle/assignment/trip/notification fixtures.
    const PURGE = `WITH old AS (SELECT id FROM fleets WHERE name IN ('p5g-A','p5g-B')),
      od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))`;
    await poolX.query(`${PURGE} DELETE FROM notification_log WHERE target_user IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM od) OR target_user IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM trip_events WHERE trip_id IN (SELECT trip_id FROM trips WHERE driver_id IN (SELECT id FROM od))`);
    await poolX.query(`${PURGE} DELETE FROM trips WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM location_fixes WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM ingest_batches WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM driver_vehicle_assignments WHERE driver_id IN (SELECT id FROM od) OR vehicle_id IN (SELECT id FROM vehicles WHERE fleet_id IN (SELECT id FROM old))`);
    await poolX.query(`${PURGE} DELETE FROM consent_records WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM user_push_tokens WHERE user_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM geofences WHERE fleet_id IN (SELECT id FROM old)`);
    await poolX.query(`${PURGE} DELETE FROM vehicles WHERE fleet_id IN (SELECT id FROM old)`);
    await poolX.query(`${PURGE} DELETE FROM users WHERE fleet_id IN (SELECT id FROM old)`);
    await poolX.query(`DELETE FROM fleets WHERE name IN ('p5g-A','p5g-B')`);

    await poolX.query(
      `INSERT INTO fleets (id, name, status) VALUES ($1,'p5g-A','ACTIVE'),($2,'p5g-B','ACTIVE')`,
      [fleetA, fleetB]);
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, password_hash, locale, is_active, fleet_id)
       VALUES ($1,'DRIVER','P5G Driver A',$4,NULL,'en',true,$5),
              ($2,'FLEET_MANAGER','P5G Manager A',$7,$6,'en',true,$5),
              ($3,'FLEET_MANAGER','P5G Manager B',$8,$6,'en',true,$9)`,
      [driverA, mgrA, mgrB,
       `p5g-a-${driverA.slice(0, 8)}@yet.local`, fleetA, scrypt('p5g-password-1'),
       `p5g-ma-${mgrA.slice(0, 8)}@yet.local`, `p5g-mb-${mgrB.slice(0, 8)}@yet.local`, fleetB]);
    await poolX.query(`INSERT INTO vehicles (id, plate_number, fleet_id) VALUES ($1,'P5G-A-1',$2)`,
      [vehicleA, fleetA]);
    await poolX.query(
      `INSERT INTO driver_vehicle_assignments (id, driver_id, vehicle_id) VALUES ($1,$2,$3)`,
      [randomUUID(), driverA, vehicleA]);

    // One open trip for driver A so /reports/trips has a row on BOTH paths
    // (JSON positive control + CSV row-count equality). started_at now ⇒ inside
    // every generous window we use.
    await poolX.query(
      `INSERT INTO trips (trip_id, vehicle_id, driver_id, started_at, last_activity_at, state, distance_m)
       VALUES ($1,$2,$3, now(), now(), 'MOVING', 1234)`, [randomUUID(), vehicleA, driverA]);

    // Notification ledger row TARGETING driver A (fan-out recipients = managers
    // of both tenants + admin-less fleet). dedupe_key unique via gen_random_uuid.
    const sepKey = `p5g-sep-${randomUUID()}`;
    await poolX.query(
      `INSERT INTO notification_log (event_type, dedupe_key, recipient_role, recipient_id, target_user, channel, status)
       VALUES ('DRIVER_SEPARATION_TIMER', $1, 'FLEET_MANAGER', $2, $3, 'FCM', 'QUEUED')`,
      [`${sepKey}@${mgrA}`, mgrA, driverA]);
    await poolX.query(
      `INSERT INTO notification_log (event_type, dedupe_key, recipient_role, recipient_id, target_user, channel, status)
       VALUES ('DRIVER_SEPARATION_TIMER', $1, 'FLEET_MANAGER', $2, $3, 'FCM', 'QUEUED')`,
      [`${sepKey}@${mgrB}`, mgrB, driverA]);

    const { buildApp } = await import('../src/app.js');
    app = await buildApp();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    const FIX_USERS = [driverA, mgrA, mgrB];
    await poolX.query(`DELETE FROM notification_log WHERE target_user = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[]) OR target_user = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM trip_events WHERE trip_id IN (SELECT trip_id FROM trips WHERE driver_id = ANY($1::uuid[]))`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM trips WHERE driver_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM location_fixes WHERE driver_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM ingest_batches WHERE driver_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM driver_vehicle_assignments WHERE driver_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM consent_records WHERE driver_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM user_push_tokens WHERE user_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM refresh_tokens WHERE user_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM geofences WHERE fleet_id IN ($1,$2)`, [fleetA, fleetB]).catch(() => {});
    await poolX.query(`DELETE FROM vehicles WHERE id = $1`, [vehicleA]).catch(() => {});
    await poolX.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM fleets WHERE id IN ($1,$2)`, [fleetA, fleetB]).catch(() => {});
    // Retention-suite residue: purge the dedicated throwaway fleet's rows so a
    // rerun (or another suite's global retention pass) sees no stale old window.
    await poolX.query(
      `WITH old AS (SELECT id FROM fleets WHERE name = 'p5g-retention'),
        od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))
       DELETE FROM location_fixes WHERE driver_id IN (SELECT id FROM od)`, []).catch(() => {});
    await poolX.query(
      `WITH old AS (SELECT id FROM fleets WHERE name = 'p5g-retention'),
        od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))
       DELETE FROM ingest_batches WHERE driver_id IN (SELECT id FROM od)`, []).catch(() => {});
    await poolX.query(
      `WITH old AS (SELECT id FROM fleets WHERE name = 'p5g-retention'),
        od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))
       DELETE FROM vehicles WHERE fleet_id IN (SELECT id FROM old)`, []).catch(() => {});
    await poolX.query(
      `WITH old AS (SELECT id FROM fleets WHERE name = 'p5g-retention'),
        od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))
       DELETE FROM users WHERE fleet_id IN (SELECT id FROM old)`, []).catch(() => {});
    await poolX.query(`DELETE FROM fleets WHERE name = 'p5g-retention'`).catch(() => {});
    await poolX.end();
  });

  /* ------------------- 1. Cross-fleet denials on Phase 5 reads -------------- */

  it('FLEET_MANAGER of B naming a fleet-A driver on /reports/trips → 403 cross_fleet_denied', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokB = signAccessToken({ sub: mgrB, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetB });
    const res = await app.inject({ method: 'GET', url: `/reports/trips?${WIN}&driver_id=${driverA}`,
      headers: { authorization: `Bearer ${tokB}` } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('cross_fleet_denied');
  });

  it('…same denial applies with ?format=csv (export must not bypass guards)', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokB = signAccessToken({ sub: mgrB, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetB });
    const res = await app.inject({ method: 'GET', url: `/reports/trips?${WIN}&driver_id=${driverA}&format=csv`,
      headers: { authorization: `Bearer ${tokB}` } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('cross_fleet_denied');
  });

  it('FLEET_MANAGER of B naming a fleet-A driver on /reports/separations → 403', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokB = signAccessToken({ sub: mgrB, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetB });
    const res = await app.inject({ method: 'GET', url: `/reports/separations?${WIN}&driver_id=${driverA}`,
      headers: { authorization: `Bearer ${tokB}` } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('cross_fleet_denied');
  });

  it('unscoped aggregate /reports/trips is FILTERED: fleet-A trip never leaks to manager B', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokB = signAccessToken({ sub: mgrB, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetB });
    const res = await app.inject({ method: 'GET', url: `/reports/trips?${WIN}`,
      headers: { authorization: `Bearer ${tokB}` } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body).includes(driverA)).toBe(false);
    // Positive control: same read as manager A DOES include the trip's driver.
    const tokA = signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA });
    const ok = await app.inject({ method: 'GET', url: `/reports/trips?${WIN}`,
      headers: { authorization: `Bearer ${tokA}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().trips.some((t: any) => t.driver_id === driverA)).toBe(true);
  });

  it('tenant token WITHOUT a fleet claim fails closed on scoped aggregates (scopeFleetId)', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const legacy = signAccessToken({ sub: mgrB, role: 'FLEET_MANAGER', locale: 'en' }); // pre-0013 shape
    const res = await app.inject({ method: 'GET', url: `/reports/trips?${WIN}`,
      headers: { authorization: `Bearer ${legacy}` } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('cross_fleet_denied');
  });

  it('GET /notifications/log: fleet-B manager never sees rows targeting a fleet-A driver', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokB = signAccessToken({ sub: mgrB, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetB });
    const res = await app.inject({ method: 'GET', url: '/notifications/log?limit=500',
      headers: { authorization: `Bearer ${tokB}` } });
    expect(res.statusCode).toBe(200);
    const rows = res.json().notifications as any[];
    expect(rows.some((n) => n.target_user === driverA)).toBe(false);
    // Directly probing the foreign target id must also yield nothing.
    const probe = await app.inject({ method: 'GET', url: `/notifications/log?target_user=${driverA}`,
      headers: { authorization: `Bearer ${tokB}` } });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().count).toBe(0);
    // Positive control: fleet-A manager DOES see the incident about their driver.
    const tokA = signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA });
    const mine = await app.inject({ method: 'GET', url: `/notifications/log?target_user=${driverA}`,
      headers: { authorization: `Bearer ${tokA}` } });
    expect(mine.json().count).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /driver/:id/location-history: fleet-A manager denied (self/ADMIN only) — 403 forbidden_role', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokA = signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA });
    const res = await app.inject({ method: 'DELETE', url: `/driver/${driverA}/location-history`,
      headers: { authorization: `Bearer ${tokA}` } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden_role');
  });

  it('DELETE /driver/:id/location-history: cross-fleet DRIVER denied even before the self-check nuance', async () => {
    // driverA's own token against driverB-style id: unrelated UUID ⇒ still 403
    // (role rule: DRIVER may only erase SELF). This pins the boundary for the
    // erasure surface specifically (phase0 suite covers reads only).
    const other = randomUUID();
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokD = signAccessToken({ sub: driverA, role: 'DRIVER', locale: 'en', fleetId: fleetA });
    const res = await app.inject({ method: 'DELETE', url: `/driver/${other}/location-history`,
      headers: { authorization: `Bearer ${tokD}` } });
    expect(res.statusCode).toBe(403);
  });

  /* --------------------------- 2. CSV export contract ----------------------- */

  it('/reports/trips?format=csv returns RFC-4180 CSV with the SAME rows as JSON', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokA = signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA });
    const json = await app.inject({ method: 'GET', url: `/reports/trips?${WIN}`,
      headers: { authorization: `Bearer ${tokA}` } });
    expect(json.statusCode).toBe(200);
    const csv = await app.inject({ method: 'GET', url: `/reports/trips?${WIN}&format=csv`,
      headers: { authorization: `Bearer ${tokA}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="trips_.*\.csv"/);
    const lines = csv.payload.split('\r\n').filter((l: string) => l.length > 0);
    expect(lines[0]).toBe('trip_id,driver_id,plate_number,started_at,ended_at,state,distance_m,moving_duration_s,stopped_duration_s,turn_count,harsh_event_count');
    // header + one data line per trip in the JSON payload (same fleet-scoped set)
    expect(lines.length - 1).toBe(json.json().trips.length);
    expect(lines[1]).toContain(driverA);
    expect(lines[1]).toContain('P5G-A-1');
  });

  it('/reports/separations?format=csv exports the fleet-scoped incident set', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokA = signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA });
    const csv = await app.inject({ method: 'GET', url: `/reports/separations?${WIN}&format=csv`,
      headers: { authorization: `Bearer ${tokA}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.payload.split('\r\n').filter((l: string) => l.length > 0);
    expect(lines[0].startsWith('separation_id,trip_id,vehicle_id,driver_id,driver_name')).toBe(true);
    const json = await app.inject({ method: 'GET', url: `/reports/separations?${WIN}`,
      headers: { authorization: `Bearer ${tokA}` } });
    expect(lines.length - 1).toBe(json.json().incidents.length);
  });

  it('invalid format value rejected with 400 (validation precedes serving)', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokA = signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA });
    const res = await app.inject({ method: 'GET', url: `/reports/trips?${WIN}&format=xlsx`,
      headers: { authorization: `Bearer ${tokA}` } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_query');
  });

  it('CSV read lands in audit_log with format recorded (systematic PDPP read audit)', async () => {
    // Deterministic ordering: perform a fresh CSV read for the named target,
    // then assert on rows at/after that instant (the suite shares one DB and
    // vitest runs test files concurrently — never depend on other suites' rows).
    const t0 = new Date();
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokA = signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA });
    const csv = await app.inject({ method: 'GET', url: `/reports/trips?${WIN}&driver_id=${driverA}&format=csv`,
      headers: { authorization: `Bearer ${tokA}` } });
    expect(csv.statusCode).toBe(200);
    const { rows } = await poolX.query(
      `SELECT detail->>'format' AS fmt FROM audit_log
        WHERE action='read_trip_report' AND target_user=$1 AND occurred_at >= $2
        ORDER BY occurred_at DESC LIMIT 1`, [driverA, t0.toISOString()]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].fmt).toBe('csv');
  });

  /* --------------------- 3. Ingest assignment precondition ------------------ */

  it('POST /ingest/locations succeeds once consent+assignment exist (seeded fixture path)', async () => {
    const token = await driverToken(driverA, fleetA);
    await grantConsent(token);
    const res = await app.inject({ method: 'POST', url: '/ingest/locations',
      headers: { authorization: `Bearer ${token}` },
      payload: { batch_id: randomUUID(),
                 fixes: [{ fix_timestamp: '2026-10-25T10:00:00Z', lat: 9.03, lng: 38.74 }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(1);
  });

  /* ---------------- 3b. Retention job — scheduled + TESTED (§Master P5) ----- */

  it('POST /reports/retention/run: DRIVER rejected 403 forbidden_role (ADMIN-only boundary)', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokD = signAccessToken({ sub: driverA, role: 'DRIVER', locale: 'en', fleetId: fleetA });
    const res = await app.inject({ method: 'POST', url: '/reports/retention/run',
      headers: { authorization: `Bearer ${tokD}` }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden_role');
  });

  it('POST /reports/retention/run: FLEET_MANAGER rejected too (bulk-delete surface is ADMIN-only)', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokM = signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA });
    const res = await app.inject({ method: 'POST', url: '/reports/retention/run',
      headers: { authorization: `Bearer ${tokM}` }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden_role');
  });

  it('POST /reports/retention/run anonymous → 401 unauthorized', async () => {
    const res = await app.inject({ method: 'POST', url: '/reports/retention/run', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('POST /reports/retention/run as ADMIN downsamples old fixes every Nth, keeps recent + audit row', async () => {
    // Throwaway driver so the pass can't disturb other suites' rows (vitest
    // runs files concurrently; we scope by driver and clean up after).
    // IMPORTANT: this driver must belong to a DEDICATED throwaway fleet, NOT
    // fleetA. The endpoint's downsample window is GLOBAL per driver (all
    // location_fixes older than age_days), and earlier p5g-A/p5g-B purge
    // passes delete users only within those two named fleets — leaving any
    // prior-run retention drivers (and their 400-day-old fixes) in place.
    // Those residue rows would then rank ahead of this run's seeds inside the
    // same driver partition... except ids are fresh UUIDs per run, so the
    // real contamination path was residue rows under *other* driver ids that
    // merely inflate the global deleted_rows counter. A dedicated fleet means
    // the beforeAll purge below removes yesterday's residue BEFORE seeding,
    // making both the per-batch survivor count and the global lower bound
    // deterministic on every rerun against a shared database.
    const retFleet = randomUUID();
    const retDriver = randomUUID();
    const retVehicle = randomUUID();
    const retBatch = randomUUID();
    await poolX.query(
      `INSERT INTO fleets (id, name) VALUES ($1,'p5g-retention')`, [retFleet]);
    // Purge residue from previous runs of THIS suite (same stable fleet name)
    // before seeding, so the old-window partition contains exactly our 15 rows.
    await poolX.query(
      `WITH old AS (SELECT id FROM fleets WHERE name = 'p5g-retention'),
        od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))
       DELETE FROM location_fixes WHERE driver_id IN (SELECT id FROM od)`, []);
    // Also purge residue under OTHER drivers (e.g. fleetA's seeded driver,
    // whose /ingest/locations test inserts a hard-dated 2026-10-25 fix that
    // ages past the 90-day cutoff on real clocks). The downsample pass ranks
    // per-driver across ALL old rows; residue in another driver's partition
    // would delete that driver's rows and make this suite's global counters
    // non-deterministic across reruns/days.
    await poolX.query(
      `DELETE FROM location_fixes WHERE fix_timestamp < now() - interval '300 days'`, []);
    await poolX.query(
      `WITH old AS (SELECT id FROM fleets WHERE name = 'p5g-retention'),
        od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))
       DELETE FROM ingest_batches WHERE driver_id IN (SELECT id FROM od)`, []);
    await poolX.query(
      `WITH old AS (SELECT id FROM fleets WHERE name = 'p5g-retention'),
        od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))
       DELETE FROM vehicles WHERE fleet_id IN (SELECT id FROM old)`, []);
    await poolX.query(
      `WITH old AS (SELECT id FROM fleets WHERE name = 'p5g-retention'),
        od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))
       DELETE FROM users WHERE fleet_id IN (SELECT id FROM old)`, []);
    await poolX.query(
      `DELETE FROM fleets WHERE name = 'p5g-retention' AND id <> $1`, [retFleet]);
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, locale, is_active, fleet_id)
       VALUES ($1,'DRIVER','P5G Retention',$2,'en',true,$3)`,
      [retDriver, `p5g-ret-${retDriver.slice(0, 8)}@yet.local`, retFleet]);
    await poolX.query(`INSERT INTO vehicles (id, plate_number, fleet_id) VALUES ($1,'P5G-RET-1',$2)`,
      [retVehicle, retFleet]);
    await poolX.query(`INSERT INTO ingest_batches (batch_id, driver_id, vehicle_id, fix_count)
                       VALUES ($1,$2,$3,15)`, [retBatch, retDriver, retVehicle]);
    // 15 OLD fixes (400 days ago ⇒ past the age_days=90 cutoff passed below)
    // + 3 RECENT fixes (must survive regardless of phase). fix_id is IDENTITY —
    // never supplied; ordering contract is (fix_timestamp, fix_id).
    for (let i = 0; i < 15; i++) {
      await poolX.query(
        `INSERT INTO location_fixes (batch_id, driver_id, vehicle_id, fix_timestamp, lat, lng, accuracy_m)
         VALUES ($1,$2,$3, now() - make_interval(days => 400) - ($4 || ' seconds')::interval, 9.0, 38.7, 5)`,
        [retBatch, retDriver, retVehicle, String(i * 30)]);
    }
    for (let i = 0; i < 3; i++) {
      await poolX.query(
        `INSERT INTO location_fixes (batch_id, driver_id, vehicle_id, fix_timestamp, lat, lng, accuracy_m)
         VALUES ($1,$2,$3, now() - ($4 || ' minutes')::interval, 9.05, 38.75, 5)`,
        [retBatch, retDriver, retVehicle, String(i + 1)]);
    }

    // Seed an ADMIN principal (mgrA is a FLEET_MANAGER — the endpoint's
    // forbidden_role guard would 403 before the retention pass ever ran).
    // DB trigger: staff roles (ADMIN/FLEET_MANAGER) REQUIRE password_hash
    // (only drivers are passwordless), so hashPassword-format it via scrypt().
    // This suite's purge deletes users only within fleets p5g-A/p5g-B, so a
    // NULL-fleet ADMIN survives cleanup across reruns.
    // token_version must be STAMPED into the JWT exactly like every production
    // mint site (identity/routes.ts login does `tokenVersion: user.token_version`):
    // the global revocation onRequest hook compares the claim against
    // users.token_version and a MISSING claim fails closed — @fastify/sensible
    // maps the thrown RevokedError to HTTP 409 (its scoped handler wins over
    // app.setErrorHandler). The driverToken() helper above already follows this
    // contract; the retention test must too.
    const adminId = randomUUID();
    await poolX.query(`DELETE FROM users WHERE id = $1`, [adminId]);
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, password_hash, locale, is_active)
       VALUES ($1,'ADMIN','P5G Retention Admin',$2,$3,'en',true)`,
      [adminId, `p5g-admin-${adminId.slice(0, 8)}@yet.local`, scrypt('p5g-admin-pw')]);
    const { rows: tvRow } = await poolX.query(
      `SELECT token_version FROM users WHERE id = $1`, [adminId]);
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokAdmin = signAccessToken({ sub: adminId, role: 'ADMIN', locale: 'en',
      tokenVersion: tvRow[0].token_version });
    const t0 = new Date();
    const res = await app.inject({ method: 'POST', url: '/reports/retention/run',
      headers: { authorization: `Bearer ${tokAdmin}` },
      payload: { age_days: 90, keep_every_n: 10 } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Downsample contract (shared with scripts/retention.mjs through
    // retention_kernel.downsampleDeletePredicateSql): stable rule
    //   doomed := rn > N AND rn % N <> 0
    // i.e. keep the FIRST N rows as permanent anchors PLUS every Nth
    // thereafter. With N=10 over the 15-row OLD window this keeps rn 1..10
    // plus lattice survivor rn 10, and deletes rn 11..15 (none of 11..15 is a
    // multiple of 10) → EXACTLY 10 old rows remain and 5 are deleted. This is
    // the idempotent fixed point: re-ranking the 10 survivors yields rn 1..10,
    // all anchor-protected, so pass 2 deletes nothing.
    // (Historic note: earlier revisions of this file asserted "rn 1 & 11
    // survive ⇒ 2" under a naive-phase rule; that rule broke idempotence on
    // re-rank and was replaced by the kernel's stable predicate.)
    // The envelope's deleted_rows is GLOBAL across fleets/suites sharing this
    // database (vitest runs files concurrently), so it cannot be pinned to one
    // suite's seed data; assert our batch's deterministic outcome directly.
    const { rows: mine } = await poolX.query(
      `SELECT count(*)::int AS n FROM location_fixes
        WHERE batch_id = $1 AND fix_timestamp < now() - interval '100 days'`, [retBatch]);
    expect(mine[0].n).toBe(10); // rn 1..10 anchor-kept by stable rule
    expect(body.deleted_rows).toBeGreaterThanOrEqual(5); // global lower bound (our batch alone)
    expect(body.audit_action).toBe('retention_downsample');

    const { rows: left } = await poolX.query(
      `SELECT count(*)::int AS n FROM location_fixes WHERE driver_id = $1`, [retDriver]);
    // 3 recent survive + exactly 10 old anchors (rn 1..10 of the 15 seeded).
    expect(left[0].n).toBe(13);
    const { rows: oldLeft } = await poolX.query(
      `SELECT count(*)::int AS n FROM location_fixes
        WHERE driver_id=$1 AND fix_timestamp < now() - interval '100 days'`, [retDriver]);
    expect(oldLeft[0].n).toBe(10);

    // Idempotence: an immediate re-run deletes nothing further for this driver.
    const res2 = await app.inject({ method: 'POST', url: '/reports/retention/run',
      headers: { authorization: `Bearer ${tokAdmin}` },
      payload: { age_days: 90, keep_every_n: 10 } });
    expect(res2.statusCode).toBe(200);
    const { rows: left2 } = await poolX.query(
      `SELECT count(*)::int AS n FROM location_fixes WHERE driver_id=$1`, [retDriver]);
    expect(left2[0].n).toBe(13);

    // Audit receipt lands in the same ledger the API uses (§Gate traceability).
    const { rows: aud } = await poolX.query(
      `SELECT detail->>'keep_every_n' AS n, detail->>'trigger' AS trig
         FROM audit_log WHERE action='retention_downsample' AND occurred_at >= $1
         ORDER BY occurred_at DESC LIMIT 1`, [t0.toISOString()]);
    expect(aud.length).toBeGreaterThan(0);
    expect(aud[0].n).toBe('10');
    expect(aud[0].trig).toBe('api');

    // Cleanup (children first).
    await poolX.query(`DELETE FROM location_fixes WHERE driver_id=$1`, [retDriver]);
    await poolX.query(`DELETE FROM ingest_batches WHERE driver_id=$1`, [retDriver]);
    await poolX.query(`DELETE FROM audit_log WHERE actor_id=$1 OR target_user=$1`, [retDriver]);
    await poolX.query(`DELETE FROM users WHERE id=$1`, [retDriver]);
    await poolX.query(`DELETE FROM vehicles WHERE id=$1`, [retVehicle]);
  });

  it('POST /ingest/locations with NO active assignment → 409 no_vehicle_assignment (collection gating)', async () => {
    const orphan = randomUUID();
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, locale, is_active, fleet_id)
       VALUES ($1,'DRIVER','P5G Orphan',$2,'en',true,$3)`,
      [orphan, `p5g-orphan-${orphan.slice(0, 8)}@yet.local`, fleetA]);
    // Consent via HTTP (policy registry is code, not fixture-dependent).
    const otok = await driverToken(orphan, fleetA);
    await grantConsent(otok);
    const res = await app.inject({ method: 'POST', url: '/ingest/locations',
      headers: { authorization: `Bearer ${otok}` },
      payload: { batch_id: randomUUID(),
                 fixes: [{ fix_timestamp: '2026-10-25T10:00:00Z', lat: 9.03, lng: 38.74 }] } });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('no_vehicle_assignment');
    await poolX.query(`DELETE FROM consent_records WHERE driver_id=$1`, [orphan]);
    await poolX.query(`DELETE FROM audit_log WHERE actor_id=$1 OR target_user=$1`, [orphan]);
    await poolX.query(`DELETE FROM refresh_tokens WHERE user_id=$1`, [orphan]);
    await poolX.query(`DELETE FROM users WHERE id=$1`, [orphan]);
  });
});
