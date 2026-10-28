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
       VALUES ($1,'DRIVER','P5G Driver A',$4,$5,'en',true,$6),
              ($2,'FLEET_MANAGER','P5G Manager A',$7,$5,'en',true,$6),
              ($3,'FLEET_MANAGER','P5G Manager B',$8,$5,'en',true,$9)`,
      [driverA, mgrA, mgrB,
       `p5g-a-${driverA.slice(0, 8)}@yet.local`, scrypt('p5g-pw'), fleetA,
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
    const { rows } = await poolX.query(
      `SELECT detail->>'format' AS fmt FROM audit_log
        WHERE action='read_trip_report' AND target_user=$1 ORDER BY occurred_at DESC LIMIT 1`, [driverA]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].fmt).toBe('csv');
  });

  /* --------------------- 3. Ingest assignment precondition ------------------ */

  it('POST /ingest/locations succeeds once consent+assignment exist (seeded fixture path)', async () => {
    const login = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { identifier: `p5g-a-${driverA.slice(0, 8)}@yet.local`, password: 'p5g-pw' } });
    expect(login.statusCode).toBe(200);
    const token = login.json().access_token;
    await grantConsent(token);
    const res = await app.inject({ method: 'POST', url: '/ingest/locations',
      headers: { authorization: `Bearer ${token}` },
      payload: { batch_id: randomUUID(),
                 fixes: [{ fix_timestamp: '2026-10-25T10:00:00Z', lat: 9.03, lng: 38.74 }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(1);
  });

  it('POST /ingest/locations with NO active assignment → 409 no_vehicle_assignment (collection gating)', async () => {
    const orphan = randomUUID();
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, password_hash, locale, is_active, fleet_id)
       VALUES ($1,'DRIVER','P5G Orphan',$2,$3,'en',true,$4)`,
      [orphan, `p5g-orphan-${orphan.slice(0, 8)}@yet.local`, scrypt('p5g-pw'), fleetA]);
    // Consent via HTTP (policy registry is code, not fixture-dependent).
    const ologin = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { identifier: `p5g-orphan-${orphan.slice(0, 8)}@yet.local`, password: 'p5g-pw' } });
    expect(ologin.statusCode).toBe(200);
    await grantConsent(ologin.json().access_token);
    const res = await app.inject({ method: 'POST', url: '/ingest/locations',
      headers: { authorization: `Bearer ${ologin.json().access_token}` },
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
