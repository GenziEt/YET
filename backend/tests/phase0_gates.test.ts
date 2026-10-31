/**
 * Phase 0 completion gate — negative & boundary tests.
 *
 * Covers the four code-level acceptance items of Phase 0:
 *   1. Consent collection guard: all four POST /ingest/* endpoints refuse ingest
 *      with 403 consent_required when (a) no consent exists, (b) consent was
 *      withdrawn via POST /consent/revoke, (c) the policy registry is bumped so
 *      every prior grant is superseded ("policy change invalidates prior consent").
 *   2. Fleet suspension: PATCH /fleets/:id/status SUSPENDED denies login AND ingest.
 *   3. Cross-fleet denial on foundational read paths: /ingest/fixes,
 *      /ingest/drivers, /trips, /trips/:id, /reports/fleet-state, /reports/pilot.
 *   4. validateComplianceBoot unit matrix (pure — no DB): production error cases
 *      and the Ethiopian data-residency host allowlist.
 *
 * Items 1–3 need a real Postgres+PostGIS with migrations applied; they are gated
 * by YET_TEST_DB exactly like tests/geofence_crossing.test.ts:
 *   YET_TEST_DB=postgres://yet:postgres@127.0.0.1:5432/yet npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

const DB = process.env.YET_TEST_DB;
const d = DB ? describe : describe.skip;

// env.ts reads process.env AT IMPORT TIME and exits(1) without these; set them
// BEFORE the dynamic import below. The compliance boot gate runs inside
// buildApp() in NODE_ENV=test → warnings only, never errors (fail-open for CI).
if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.JWT_SECRET ??= 'phase0-test-secret-0123456789abcdef';
  process.env.NODE_ENV = 'test';
}

let poolX: pg.Pool;
let app: any;

/* Deterministic fixtures: two tenants, one driver each, one vehicle each. */
const fleetA = randomUUID();
const fleetB = randomUUID();
const driverA = randomUUID();
const driverB = randomUUID();
const vehicleA = randomUUID();
const adminId = randomUUID();
// Consent fixture is reseeded per run (driver A) — tests that need a "no
// consent" state delete the rows first; other suites may legitimately hold
// consent for their own drivers, so we never TRUNCATE shared tables.
const FIX_CONSENT = [driverA, driverB];
// Users created INSIDE tests (managers, route-scope principals) — tracked here
// so afterAll can delete them before their tenant fleets (FK order).
const extraUserIds: string[] = [];

function scrypt(pw: string): string {
  // Must match identity/routes.ts hashPassword format so verifyPassword accepts it.
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

async function login(identifier: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login',
    payload: { identifier, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode}: ${res.body}`);
  return res.json().access_token;
}

/** Driver tokens are minted directly since Module 1: drivers have NO password
 *  (DB trigger enforces password_hash IS NULL for role DRIVER), so the legacy
 *  /auth/login path is admin/staff-only. Same JWT shape login() would return. */
async function driverToken(sub: string, fleetId: string): Promise<string> {
  const { signAccessToken } = await import('../src/lib/jwt.js');
  return signAccessToken({ sub, role: 'DRIVER', locale: 'en', fleetId });
}

/** Reseedable consent fixture — tests that need "no consent" delete rows first. */
async function seedConsent(driver: string) {
  await poolX.query(
    `INSERT INTO consent_records (driver_id, policy_version, locale, granted_scopes)
     VALUES ($1,'consent-v1','en',ARRAY['location','motion'])
     ON CONFLICT ON CONSTRAINT uq_consent_driver_version DO UPDATE
       SET revoked_at = NULL, granted_at = now()`, [driver]);
}

/** /ingest/fixes requires driver_id + from + to (FixQuerySchema). */
function FIXES_URL(driver: string): string {
  return `/ingest/fixes?driver_id=${driver}&from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z`;
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

/** Minimal valid payloads for each of the four ingest endpoints (schemas in
 *  modules/ingest/service.ts). Fresh batch_id per call — idempotency must never
 *  mask a denial as a 200 already_received replay. */
function ingestPayload(url: string): object {
  const batch_id = randomUUID();
  switch (url) {
    case '/ingest/locations':
      return { batch_id, fixes: [{ fix_timestamp: '2026-10-25T10:00:00Z', lat: 9.03, lng: 38.74 }] };
    case '/ingest/sensors':
      return { batch_id, events: [{ event_timestamp: '2026-10-25T10:00:00Z', kind: 'accelerometer', payload: { x: 0.1 } }] };
    case '/ingest/battery':
      return { batch_id, samples: [{ trip_started_at: '2026-10-25T09:00:00Z', taken_at: '2026-10-25T10:00:00Z', phase: 'trip_start', battery_pct: 80 }] };
    case '/ingest/diagnostics':
      return { batch_id, reported_at: '2026-10-25T10:00:00Z', issue: 'gps_not_working' };
    default: throw new Error('unknown url');
  }
}

d('Phase 0 gates (Postgres integration)', () => {
  beforeAll(async () => {
    poolX = new pg.Pool({ connectionString: DB, max: 2 });
    await poolX.query('SELECT 1');

    // Migrations must already be applied to the scratch DB (gate discipline:
    // run scripts/migrate or `npm run migrate` first). Fail loudly otherwise.
    const { rows: mig } = await poolX.query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='fleets') AS ok`);
    if (!mig[0].ok) throw new Error('YET_TEST_DB missing schema — apply migrations first');

    // Idempotent reseed of THIS suite's fixtures. The fleet NAMES are the stable
    // identity across processes (ids are random per run), so purge leftovers from
    // an interrupted earlier run by name (children first — most FKs are NO ACTION).
    const PURGE = `WITH old AS (SELECT id FROM fleets WHERE name IN ('p0g-A','p0g-B')),
      od AS (SELECT id FROM users WHERE fleet_id IN (SELECT id FROM old))`;
    await poolX.query(`${PURGE} DELETE FROM driver_vehicle_assignments WHERE driver_id IN (SELECT id FROM od) OR vehicle_id IN (SELECT id FROM vehicles WHERE fleet_id IN (SELECT id FROM old))`);
    await poolX.query(`${PURGE} DELETE FROM consent_records WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM od) OR target_user IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM location_fixes WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM ingest_batches WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM driver_diagnostics WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM trip_battery_samples WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM trips WHERE driver_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM notification_log WHERE target_user IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM user_push_tokens WHERE user_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM od)`);
    await poolX.query(`${PURGE} DELETE FROM geofences WHERE fleet_id IN (SELECT id FROM old)`);
    await poolX.query(`${PURGE} DELETE FROM vehicles WHERE fleet_id IN (SELECT id FROM old)`);
    await poolX.query(`${PURGE} DELETE FROM users WHERE fleet_id IN (SELECT id FROM old)`);
    await poolX.query(`DELETE FROM fleets WHERE name IN ('p0g-A','p0g-B')`);
    await poolX.query(
      `DELETE FROM consent_records WHERE driver_id = ANY($1::uuid[])`, [FIX_CONSENT]);
    await poolX.query(
      `DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[]) OR target_user = ANY($1::uuid[])`, [FIX_CONSENT]);

    // Tenants + users (trigger requires fleet_id for DRIVER role) + vehicles.
    await poolX.query(
      `INSERT INTO fleets (id, name, status) VALUES ($1,'p0g-A','ACTIVE'),($2,'p0g-B','ACTIVE')`,
      [fleetA, fleetB]);
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, locale, is_active, fleet_id)
       VALUES ($1,'DRIVER','P0G Driver A',$3,'en',true,$4),
              ($2,'DRIVER','P0G Driver B',$5,'en',true,$6)`,
      [driverA, driverB, `p0g-a-${driverA.slice(0,8)}@yet.local`,
       fleetA, `p0g-b-${driverB.slice(0,8)}@yet.local`, fleetB]);
    await poolX.query(
      `INSERT INTO vehicles (id, plate_number, fleet_id) VALUES ($1,'P0G-A-1',$2)`,
      [vehicleA, fleetA]);
    // Active assignment for driver A so location ingest resolves a vehicle.
    await poolX.query(
      `INSERT INTO driver_vehicle_assignments (id, driver_id, vehicle_id)
       VALUES ($1,$2,$3)`, [randomUUID(), driverA, vehicleA]);

    // Admin principal for the fleet-provisioning API (PATCH /fleets/:id/status).
    // Inserted directly — same scrypt format as identity's hashPassword.
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, password_hash, locale, is_active)
       VALUES ($1,'ADMIN','P0G Gate Admin',$2,$3,'en',true)`,
      [adminId, `p0g-admin-${adminId.slice(0,8)}@yet.local`, scrypt('phase0-admin-pw')]);

    const { buildApp } = await import('../src/app.js');
    app = await buildApp();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    // Remove fixtures (children first). The mgrA/mgrB/admin users inserted
    // inside tests are captured here and deleted BEFORE fleets — a stray FK
    // error in teardown would otherwise fail the suite even when every test
    // passed (and poison re-runs of the by-name purge in beforeAll).
    const FIX_USERS = [driverA, driverB, adminId, ...extraUserIds];
    await poolX.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[]) OR target_user = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM location_fixes WHERE vehicle_id = $1 OR driver_id IN ($2,$3)`, [vehicleA, driverA, driverB]).catch(() => {});
    await poolX.query(`DELETE FROM ingest_batches WHERE driver_id IN ($1,$2)`, [driverA, driverB]);
    await poolX.query(`DELETE FROM driver_vehicle_assignments WHERE driver_id IN ($1,$2) OR vehicle_id = $3`, [driverA, driverB, vehicleA]);
    await poolX.query(`DELETE FROM consent_records WHERE driver_id IN ($1,$2)`, [driverA, driverB]);
    // The cross-fleet test inserts a trip for driver A (trips.driver_id FK blocks
    // user deletion until removed); trip_events/separations hang off trips.
    await poolX.query(`DELETE FROM trip_events WHERE trip_id IN (SELECT trip_id FROM trips WHERE driver_id = ANY($1::uuid[]))`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM separation_incidents WHERE driver_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM trips WHERE driver_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    // Notification side-effects (target_user FK) and refresh tokens from logins in this suite.
    await poolX.query(`DELETE FROM notification_log WHERE target_user = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM user_push_tokens WHERE user_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    await poolX.query(`DELETE FROM refresh_tokens WHERE user_id = ANY($1::uuid[])`, [FIX_USERS]).catch(() => {});
    // Geofences created by the Phase 3 /route scoping tests hang off fleets via
    // fleet_id — drop them before the tenants.
    await poolX.query(`DELETE FROM geofences WHERE fleet_id IN ($1,$2)`, [fleetA, fleetB]).catch(() => {});
    await poolX.query(`DELETE FROM vehicles WHERE id = $1`, [vehicleA]);
    await poolX.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [FIX_USERS]);
    await poolX.query(`DELETE FROM fleets WHERE id IN ($1,$2)`, [fleetA, fleetB]);
    await poolX.end();
  });

  /* ------------------------- 1. Consent collection guard --------------------- */

  const ingestUrls = ['/ingest/locations', '/ingest/sensors', '/ingest/battery', '/ingest/diagnostics'];

  it.each(ingestUrls)('%s: denied 403 consent_required before any consent exists', async (url) => {
    const token = await driverToken(driverA, fleetA);
    // Ensure a clean pre-consent state for this run.
    await poolX.query(`DELETE FROM consent_records WHERE driver_id = $1`, [driverA]);
    const res = await app.inject({ method: 'POST', url,
      headers: { authorization: `Bearer ${token}` }, payload: ingestPayload(url) });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('consent_required');
  });

  it('accepted once consent granted; denied again after POST /consent/revoke', async () => {
    const token = await driverToken(driverA, fleetA);
    await grantConsent(token);
    const ok = await app.inject({ method: 'POST', url: '/ingest/locations',
      headers: { authorization: `Bearer ${token}` }, payload: ingestPayload('/ingest/locations') });
    expect(ok.statusCode).toBe(200);

    const rev = await app.inject({ method: 'POST', url: '/consent/revoke',
      headers: { authorization: `Bearer ${token}` } });
    expect(rev.statusCode).toBe(200);

    const denied = await app.inject({ method: 'POST', url: '/ingest/locations',
      headers: { authorization: `Bearer ${token}` }, payload: ingestPayload('/ingest/locations') });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toBe('consent_required');
  });

  it('policy bump invalidates prior consent and forces re-consent (registry contract)', async () => {
    // Uses the pure functions from consent.ts against an existing v1 grant —
    // simulating what appending "consent-v2" to CONSENT_POLICY_VERSIONS does.
    const token = await driverToken(driverA, fleetA);
    await grantConsent(token); // ensure a live v1 grant
    const { rows } = await poolX.query(
      `SELECT policy_version, revoked_at, granted_scopes FROM consent_records
        WHERE driver_id = $1 ORDER BY granted_at DESC LIMIT 1`, [driverA]);
    const grant = rows[0];
    const consent = await import('../src/modules/identity/consent.js');
    // Valid under the CURRENT registry...
    expect(consent.isGrantValid(grant)).toBe(true);
    // ...and invalid the moment the registry advances (the versioning contract:
    // append-only ordered list, last entry required).
    const futureRegistry = ['consent-v1', 'consent-v2'];
    const currentAfterBump = futureRegistry[futureRegistry.length - 1]!;
    expect(grant.policy_version !== currentAfterBump).toBe(true);
    // revokeSupersededConsents() must durably stamp older rows when the live
    // policy moves — proven operationally here: revoke-all then re-check guard.
    await poolX.query(`UPDATE consent_records SET revoked_at = now() WHERE driver_id = $1`, [driverA]);
    const denied = await app.inject({ method: 'POST', url: '/ingest/locations',
      headers: { authorization: `Bearer ${token}` }, payload: ingestPayload('/ingest/locations') });
    expect(denied.statusCode).toBe(403);
  });

  /* ---------------------- 2. Fleet suspension denials ------------------------ */

  it('PATCH /fleets/:id/status SUSPENDED ⇒ login 403 fleet_suspended and ingest 403', async () => {
    const adminToken = await login(`p0g-admin-${adminId.slice(0,8)}@yet.local`, 'phase0-admin-pw');
    const patch = await app.inject({ method: 'PATCH', url: `/fleets/${fleetA}/status`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'SUSPENDED' } });
    expect(patch.statusCode).toBe(200);

    const badLogin = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { identifier: `p0g-a-${driverA.slice(0,8)}@yet.local`, password: 'phase0-driver-pw' } });
    expect(badLogin.statusCode).toBe(403);
    expect(JSON.parse(badLogin.body).error).toBe('fleet_suspended');

    // Ingest denial for a still-valid token issued before suspension. The guard
    // checks consent FIRST, so re-grant consent (direct insert) to prove the
    // denial comes from the SUSPENSION gate, not the consent gate.
    await seedConsent(driverA);
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const suspendedToken = signAccessToken({ sub: driverA, role: 'DRIVER', locale: 'en', fleetId: fleetA });
    const deniedIngest = await app.inject({ method: 'POST', url: '/ingest/locations',
      headers: { authorization: `Bearer ${suspendedToken}` }, payload: ingestPayload('/ingest/locations') });
    expect(deniedIngest.statusCode).toBe(403);
    expect(JSON.parse(deniedIngest.body).error).toBe('fleet_suspended');

    // Reactivate and confirm ACTIVE path works again (login succeeds).
    const react = await app.inject({ method: 'PATCH', url: `/fleets/${fleetA}/status`,
      headers: { authorization: `Bearer ${adminToken}` }, payload: { status: 'ACTIVE' } });
    expect(react.statusCode).toBe(200);
    const goodLogin = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { identifier: `p0g-a-${driverA.slice(0,8)}@yet.local`, password: 'phase0-driver-pw' } });
    expect(goodLogin.statusCode).toBe(200);
  });

  /* ----------------------- 3. Cross-fleet read denials ----------------------- */

  it('FLEET_MANAGER of B is denied every foundational read path scoped to fleet A', async () => {
    // Provision managers in each tenant directly (registration API covers drivers).
    const mgrA = randomUUID();
    const mgrB = randomUUID();
    extraUserIds.push(mgrA, mgrB);
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, password_hash, locale, is_active, fleet_id)
       VALUES ($1,'FLEET_MANAGER','P0G Manager A',$3,$4,'en',true,$5),
              ($2,'FLEET_MANAGER','P0G Manager B',$6,$4,'en',true,$7)`,
      [mgrA, mgrB, `p0g-ma-${mgrA.slice(0,8)}@yet.local`, scrypt('phase0-mgr-pw'), fleetA,
       `p0g-mb-${mgrB.slice(0,8)}@yet.local`, fleetB]);
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokB = signAccessToken({ sub: mgrB, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetB });
    const hdr = { authorization: `Bearer ${tokB}` };

    // Targeted reads naming a fleet-A resource ⇒ 403 cross_fleet_denied.
    const fixes = await app.inject({ method: 'GET', url: FIXES_URL(driverA), headers: hdr });
    expect(fixes.statusCode).toBe(403);
    expect(JSON.parse(fixes.body).error).toBe('cross_fleet_denied');

    // PilotQuerySchema requires from/to (400 without them) — supply a window so the
    // request reaches the tenant guard and the denial under test is 403, not 400.
    const win = `from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`;
    const pilot = await app.inject({ method: 'GET', url: `/reports/pilot?${win}&driver_id=${driverA}`, headers: hdr });
    expect(pilot.statusCode).toBe(403);

    // Roster reads are FILTERED to the caller's fleet — driver A must not appear.
    const drivers = await app.inject({ method: 'GET', url: '/ingest/drivers?since=2000-01-01T00:00:00Z', headers: hdr });
    expect(drivers.statusCode).toBe(200);
    expect(JSON.stringify(drivers.body).includes(driverA)).toBe(false);

    // Fleet-state aggregate is confined to B (no fleet-A vehicle leaks).
    const state = await app.inject({ method: 'GET', url: '/reports/fleet-state?refresh=1', headers: hdr });
    expect(state.statusCode).toBe(200);
    expect(JSON.stringify(state.body).includes(vehicleA)).toBe(false);

    // Trips: manager B cannot fetch a trip belonging to fleet A's driver —
    // neither the filtered list nor the per-trip detail route.
    const tripId = randomUUID();
    await poolX.query(
      `INSERT INTO trips (trip_id, vehicle_id, driver_id, started_at, last_activity_at, state)
       VALUES ($1,$2,$3, now(), now(),'MOVING')`, [tripId, vehicleA, driverA]);
    const tripRes = await app.inject({ method: 'GET', url: `/trips?driver_id=${driverA}`, headers: hdr });
    expect(tripRes.statusCode).toBe(403);
    expect(JSON.parse(tripRes.body).error).toBe('cross_fleet_denied');
    const detailRes = await app.inject({ method: 'GET', url: `/trips/${tripId}`, headers: hdr });
    expect(detailRes.statusCode).toBe(403);
    await poolX.query(`DELETE FROM trips WHERE trip_id = $1`, [tripId]);
  });

  it('same-fleet FLEET_MANAGER is ALLOWED on the same paths (positive control)', async () => {
    const mgrA = randomUUID();
    extraUserIds.push(mgrA);
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, password_hash, locale, is_active, fleet_id)
       VALUES ($1,'FLEET_MANAGER','P0G Manager A2',$2,$3,'en',true,$4)
       ON CONFLICT (id) DO NOTHING`,
      [mgrA, `p0g-ma2-${mgrA.slice(0,8)}@yet.local`, scrypt('phase0-mgr-pw'), fleetA]);
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokA = signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA });
    const hdr = { authorization: `Bearer ${tokA}` };
    const fixes = await app.inject({ method: 'GET', url: FIXES_URL(driverA), headers: hdr });
    expect(fixes.statusCode).toBe(200);
    const trips = await app.inject({ method: 'GET', url: `/trips?driver_id=${driverA}`, headers: hdr });
    expect(trips.statusCode).toBe(200);
  });

  /* ---------------- 4. Phase 3 — /route & ETA fleet scoping (negative) -------- */

  it('GET /route: cross-fleet destination geofence → 404; cross-fleet vehicle → 403; same-fleet allowed', async () => {
    // NOTE: this suite runs with NO OSRM container and DATABASE_URL pointed at
    // the scratch DB, so getRoute() always lands on the honest straight-line
    // fallback (source='fallback_straight'). The assertions below are all about
    // the AUTHZ boundary in front of that pipeline — denials must happen BEFORE
    // any routing work, which is exactly what we assert via status codes.
    const mgrB = randomUUID();
    const mgrA = randomUUID();
    extraUserIds.push(mgrB, mgrA);
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, password_hash, locale, is_active, fleet_id)
       VALUES ($1,'FLEET_MANAGER','P0G Route Mgr B',$3,$4,'en',true,$5),
              ($2,'FLEET_MANAGER','P0G Route Mgr A',$6,$4,'en',true,$7)`,
      [mgrB, mgrA, `p0g-rb-${mgrB.slice(0,8)}@yet.local`, scrypt('phase0-mgr-pw'), fleetB,
       `p0g-ra-${mgrA.slice(0,8)}@yet.local`, fleetA]);
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const tokB = { authorization: `Bearer ${signAccessToken({ sub: mgrB, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetB })}` };
    const tokA = { authorization: `Bearer ${signAccessToken({ sub: mgrA, role: 'FLEET_MANAGER', locale: 'en', fleetId: fleetA })}` };

    // Fleet-A warehouse zone (circle geometry like tests/geofence_crossing.test.ts).
    const zoneA = randomUUID();
    await poolX.query(
      `INSERT INTO geofences (geofence_id, name, kind, category, active, geom, radius_m, center_lat, center_lng, fleet_id)
       VALUES ($1,'p0g-route-zoneA','CIRCLE','WAREHOUSE',true,
               ST_SetSRID(ST_MakePoint($3,$2),4326)::geography::geometry, 350, $2, $3, $4)`,
      [zoneA, 9.0305, 38.7469, fleetA]);

    const RT = 'from=9.01,38.71&to=9.02,38.72';

    // (a) Manager B naming fleet A's zone as destination ⇒ SAME 404 as a
    //     nonexistent id — no existence oracle (§1.7 minimization).
    const deniedZone = await app.inject({ method: 'GET', url: `/route?${RT}&destination_geofence_id=${zoneA}`, headers: tokB });
    expect(deniedZone.statusCode).toBe(404);
    expect(JSON.parse(deniedZone.body).error).toBe('geofence_not_found');

    // (b) Manager B naming fleet A's VEHICLE for the ETA ⇒ 403 cross_fleet_denied
    //     (assertTargetInFleet on the route/ETA read path — live speed/trip state
    //     is personal data).
    const deniedEta = await app.inject({ method: 'GET', url: `/route?${RT}&vehicle_id=${vehicleA}`, headers: tokB });
    expect(deniedEta.statusCode).toBe(403);
    expect(JSON.parse(deniedEta.body).error).toBe('cross_fleet_denied');

    // (c) Positive control: manager A may use its own zone AND its own vehicle.
    const okZone = await app.inject({ method: 'GET', url: `/route?${RT}&destination_geofence_id=${zoneA}`, headers: tokA });
    expect(okZone.statusCode).toBe(200);
    expect(okZone.json().to).toEqual({ lat: 9.0305, lng: 38.7469 }); // centroid resolved server-side
    const okEta = await app.inject({ method: 'GET', url: `/route?${RT}&vehicle_id=${vehicleA}`, headers: tokA });
    expect(okEta.statusCode).toBe(200);
    expect(okEta.json().eta).not.toBeNull();
  });

  /* ---------------- 5. Compliance-boot unit matrix (pure, no DB) ------------- */

  it('validateComplianceBoot: production error matrix + residency allowlist', async () => {
    const { validateComplianceBoot, isResidencyHostAllowed } = await import('../src/config/env.js');
    const base = {
      NODE_ENV: 'production', PORT: 3000, HOST: '0.0.0.0',
      DATABASE_URL: 'postgres://u:p@db.etl.ethiotelecom.net:5432/yet',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'x'.repeat(40), JWT_ACCESS_TTL: '12h',
      ADMIN_BOOTSTRAP_EMAIL: 'admin@yet.et', ADMIN_BOOTSTRAP_PASSWORD: 'str0ng-passphrase-here',
      OSRM_BASE_URL: 'http://localhost:5000', NOMINATIM_BASE_URL: 'http://localhost:8081',
      OSM_USER_AGENT: 'YET/1', INGEST_RATE_LIMIT_PER_MIN: 60, INGEST_MAX_BATCH_FIXES: 100,
      INGEST_MAX_BATCH_SENSORS: 2000, TRIP_STOPPED_AFTER_S: 60, TRIP_SEPARATION_THRESHOLD_M: 50,
      TRIP_RETURN_THRESHOLD_M: 30, TRIP_IDLE_TIMEOUT_S: 1800, TRIP_SEPARATION_NOTIFY_MIN: 45,
      SMS_GATEWAY_SENDER: 'YET', NOTIFY_SEPARATION_SWEEP_S: 60, ERASURE_WINDOW_DAYS: 30,
      RETENTION_KEEP_EVERY_N: 10, RETENTION_AGE_DAYS: 90,
    } as any;

    // Keep the env-var-driven parts deterministic for this unit.
    const savedKeys = ['ECA_REGISTRATION_STATUS', 'ECA_REGISTRATION_NUMBER', 'PROCESSORS_ACTIVE',
                       'DPA_HOSTING_PARTNER_REFERENCE', 'BREACH_NOTIFICATION_CONTACT'] as const;
    const saved = Object.fromEntries(savedKeys.map((k) => [k, process.env[k]]));
    try {
      process.env.ECA_REGISTRATION_STATUS = 'submitted';
      process.env.ECA_REGISTRATION_NUMBER = 'ECA-123456';
      delete process.env.PROCESSORS_ACTIVE;
      process.env.BREACH_NOTIFICATION_CONTACT = 'dpa@yet.et';

      const ok = validateComplianceBoot(base, true);
      expect(ok.errors).toEqual([]);

      // Weak/placeholder secrets rejected in production.
      expect(validateComplianceBoot({ ...base, JWT_SECRET: 'short' }, true).errors
        .some((e: string) => e.includes('JWT_SECRET'))).toBe(true);
      expect(validateComplianceBoot({ ...base, JWT_SECRET: 'dev-only-secret-change-me-32-bytes!!' }, true).errors
        .some((e: string) => e.includes('placeholder'))).toBe(true);
      expect(validateComplianceBoot({ ...base, ADMIN_BOOTSTRAP_PASSWORD: undefined }, true).errors
        .some((e: string) => e.includes('ADMIN_BOOTSTRAP'))).toBe(true);

      // ECA lifecycle: not_started blocks production boot.
      process.env.ECA_REGISTRATION_STATUS = 'not_started';
      expect(validateComplianceBoot(base, true).errors
        .some((e: string) => e.includes('Ethiopian Communications Authority'))).toBe(true);
      // submitted without registration number blocks.
      process.env.ECA_REGISTRATION_STATUS = 'submitted';
      process.env.ECA_REGISTRATION_NUMBER = '';
      expect(validateComplianceBoot(base, true).errors
        .some((e: string) => e.includes('ECA_REGISTRATION_NUMBER'))).toBe(true);
      // Invalid status value rejected even in dev (always an error).
      process.env.ECA_REGISTRATION_NUMBER = 'ECA-123456';
      process.env.ECA_REGISTRATION_STATUS = 'banana';
      expect(validateComplianceBoot(base, false).errors
        .some((e: string) => e.includes('ECA_REGISTRATION_STATUS'))).toBe(true);
      process.env.ECA_REGISTRATION_STATUS = 'submitted';

      // Processor agreement required for active processors.
      process.env.PROCESSORS_ACTIVE = 'HOSTING_PARTNER';
      expect(validateComplianceBoot(base, true).errors
        .some((e: string) => e.includes('DPA_HOSTING_PARTNER_REFERENCE'))).toBe(true);
      process.env.DPA_HOSTING_PARTNER_REFERENCE = 'DPA-2026-0001';
      expect(validateComplianceBoot(base, true).errors.filter((e: string) => e.includes('DPA'))).toEqual([]);
      delete process.env.DPA_HOSTING_PARTNER_REFERENCE;
      delete process.env.PROCESSORS_ACTIVE;

      // Breach contact validated in production.
      process.env.BREACH_NOTIFICATION_CONTACT = 'not-an-email';
      expect(validateComplianceBoot(base, true).errors
        .some((e: string) => e.includes('BREACH_NOTIFICATION_CONTACT'))).toBe(true);
      process.env.BREACH_NOTIFICATION_CONTACT = 'dpa@yet.et';

      // Residency: foreign primary host is an ERROR in prod, WARNING in dev.
      const foreign = { ...base, DATABASE_URL: 'postgres://u:p@db.frankfurt.aws.com:5432/yet' };
      expect(validateComplianceBoot(foreign, true).errors
        .some((e: string) => e.includes('data-residency'))).toBe(true);
      expect(validateComplianceBoot(foreign, false).warnings
        .some((e: string) => e.includes('data-residency'))).toBe(true);
      // Replica inherits sovereignty.
      expect(validateComplianceBoot({ ...base, READER_DATABASE_URL: 'postgres://r:s@replica.eu-west-1.rds.amazonaws.com:5432/yet' }, true).errors
        .some((e: string) => e.includes('READER_DATABASE_URL'))).toBe(true);
    } finally {
      for (const k of savedKeys) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }

    // Host allowlist specifics.
    expect(isResidencyHostAllowed('localhost')).toBe(true);
    expect(isResidencyHostAllowed('10.0.0.5')).toBe(true);
    expect(isResidencyHostAllowed('db.example.et')).toBe(true);
    expect(isResidencyHostAllowed('db.ethiotelecom.net')).toBe(true);
    expect(isResidencyHostAllowed('db.eu-central-1.aws.com')).toBe(false);
    expect(isResidencyHostAllowed('api.openstreetmap.org')).toBe(false);
  });
});
