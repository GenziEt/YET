/**
 * Driver onboarding WITHOUT login — gate tests (migration 0016 + identity
 * onboarding module). Style mirrors tests/phase5_gates.test.ts: real Postgres
 * fixtures gated by YET_TEST_DB, app under Fastify inject, Redis OTP leg via
 * the FakeCacheStore seam (no containers needed).
 *
 * Covers the contract:
 *   - OTP request → verify → register: driver created with NO password, lands
 *     in 'Unassigned Fleet', status PENDING_REVIEW, device paired.
 *   - No recurring login: POST /auth/session/refresh mints a new token from
 *     the pairing alone; revoked pairing ⇒ refresh denied.
 *   - Identity = phone, NOT plate: re-registration with the same phone never
 *     creates a second account; changing truck = new time-bound assignment.
 *   - Admin B2B assignment: fleet move + assign-vehicle stamps
 *     created_by_admin and closes the previous assignment; document VERIFY is
 *     cross-fleet denied for FLEET_MANAGER.
 *   - Mandatory license upload: DRIVING_LICENSE accepted, bad type rejected.
 *
 *   YET_TEST_DB=postgres://yet:postgres@127.0.0.1:5432/yet npm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

const DB = process.env.YET_TEST_DB;
const d = DB ? describe : describe.skip;

if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.JWT_SECRET ??= 'onboarding-test-secret-0123456789abcdef';
  process.env.NODE_ENV = 'test';
  process.env.OTP_DEV_ECHO = 'false';
}

const redis = await import('../src/lib/redis.js');
interface Entry { v: string; expiresAt: number }
function makeFake() {
  const map = new Map<string, Entry>();
  const now = () => Date.now();
  const store: redis.FakeCacheStore = {
    get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (e.expiresAt <= now()) { map.delete(key); return null; }
      return e.v;
    },
    set(key, value, ttlSeconds) { map.set(key, { v: value, expiresAt: now() + ttlSeconds * 1000 }); },
    del(key) { map.delete(key); },
    keys(pattern) {
      const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return [...map.keys()].filter((k) => {
        if (!re.test(k)) return false;
        const e = map.get(k)!;
        if (e.expiresAt > now()) return true;
        map.delete(k); return false;
      });
    },
  };
  return { store, map };
}

// Deterministic OTP injection: bypasses the SMS leg entirely by writing the
// hashed code into the fake cache exactly as the route does.
function putOtp(phone: string, code: string) {
  const hash = crypto.createHash('sha256').update(`${phone}.${code}.yet-otp-v1`).digest('hex');
  redis.cacheSetJson(`otp:${phone}`, JSON.parse(JSON.stringify(hash)), 300);
}

d('driver onboarding without login (module 1, migration 0016)', () => {
  let poolX: pg.Pool;
  let app: any;
  let fake: ReturnType<typeof makeFake>;

  let FLEET = randomUUID();         // real tenant the admin moves the driver to
  const ADMIN = randomUUID();
  const MGR = randomUUID();         // fleet manager of FLEET
  const PHONE = '+251911111111';
  const DEVICE = `dev-${randomUUID().slice(0, 13)}`;
  const extraUserIds: string[] = [];
  let driverId = '';
  let UF_FIXED = randomUUID();      // Unassigned Fleet (created by 0016 if absent)

  beforeAll(async () => {
    poolX = new pg.Pool({ connectionString: DB! });
    // Ensure the onboarding prerequisites exist even against older scratch DBs.
    const { rows: uf } = await poolX.query(`SELECT id FROM fleets WHERE name = 'Unassigned Fleet'`);
    if (uf.length === 0) await poolX.query(`INSERT INTO fleets (id, name) VALUES ($1,'Unassigned Fleet')`, [UF_FIXED]);
    else UF_FIXED = uf[0].id;
    // ON CONFLICT (name): a scratch DB may already carry this fleet under a
    // different id; blindly inserting the fresh UUID violates the unique name.
    await poolX.query(
      `INSERT INTO fleets (id, name) VALUES ($1,'Onboard Test Fleet')
       ON CONFLICT (name) DO NOTHING`, [FLEET]);
    const { rows: fl } = await poolX.query(`SELECT id FROM fleets WHERE name = 'Onboard Test Fleet'`);
    if (fl[0].id !== FLEET) {
      // Rebind references to the pre-existing row and adopt its id for the run.
      await poolX.query(`UPDATE users SET fleet_id = $1 WHERE fleet_id = $2`, [fl[0].id, FLEET]).catch(() => {});
      await poolX.query(`UPDATE vehicles SET fleet_id = $1 WHERE fleet_id = $2`, [fl[0].id, FLEET]).catch(() => {});
      await poolX.query(`DELETE FROM fleets WHERE id = $1`, [FLEET]).catch(() => {});
      await poolX.query(`UPDATE fleets SET status = 'ACTIVE' WHERE id = $1`, [fl[0].id]).catch(() => {});
      FLEET = fl[0].id;
    }
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, password_hash, locale)
       VALUES ($1,'ADMIN','OBG Admin',$2,$3,'en') ON CONFLICT DO NOTHING`,
      [ADMIN, `obg-admin-${ADMIN.slice(0, 8)}@yet.local`, scrypt('obg-admin-pw')]);
    await poolX.query(
      `INSERT INTO users (id, role, full_name, email, password_hash, locale, fleet_id)
       VALUES ($1,'FLEET_MANAGER','OBG Manager',$2,$3,'en',$4) ON CONFLICT DO NOTHING`,
      [MGR, `obg-mgr-${MGR.slice(0, 8)}@yet.local`, scrypt('obg-mgr-pw'), FLEET]);

    fake = makeFake();
    redis.setFakeCache(fake.store);

    const { buildApp } = await import('../src/app.js');
    app = await buildApp();
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    redis.setFakeCache(null);
    if (driverId) {
      await poolX.query(`DELETE FROM device_identities WHERE user_id = $1`, [driverId]).catch(() => {});
      await poolX.query(`DELETE FROM driver_documents WHERE driver_id = $1`, [driverId]).catch(() => {});
      await poolX.query(`DELETE FROM driver_profiles WHERE driver_id = $1`, [driverId]).catch(() => {});
      await poolX.query(
        `DELETE FROM driver_trailer_assignments WHERE driver_id = $1`, [driverId]).catch(() => {});
      await poolX.query(
        `DELETE FROM driver_vehicle_assignments WHERE driver_id = $1`, [driverId]).catch(() => {});
      await poolX.query(`DELETE FROM trailers WHERE created_by_driver_id = $1`, [driverId]).catch(() => {});
      await poolX.query(`DELETE FROM vehicles WHERE created_by_driver_id = $1`, [driverId]).catch(() => {});
      await poolX.query(`DELETE FROM audit_log WHERE actor_id = $1 OR target_user = $1`, [driverId]).catch(() => {});
      await poolX.query(`DELETE FROM otp_requests WHERE phone_e164 = $1`, [PHONE]).catch(() => {});
      await poolX.query(`DELETE FROM users WHERE id = $1`, [driverId]).catch(() => {});
    }
    await poolX.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [[ADMIN, MGR]]).catch(() => {});
    await poolX.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, MGR, ...extraUserIds]]).catch(() => {});
    await poolX.query(`DELETE FROM fleets WHERE id = $1`, [FLEET]).catch(() => {});
    await poolX.end();
  });

  beforeEach(() => {
    // fresh fake cache per test (OTP one-shot semantics depend on isolation)
    fake = makeFake();
    redis.setFakeCache(fake.store);
  });

  function scrypt(pw: string): string {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(pw, salt, 64);
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
  }

  async function adminToken(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { identifier: `obg-admin-${ADMIN.slice(0, 8)}@yet.local`, password: 'obg-admin-pw' } });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).access_token;
  }

  /* --------------------------- 1. Registration flow -------------------------- */

  it('rejects registration without OTP', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: {
      phone: PHONE, device_id: DEVICE, full_name: 'Ovg Driver', license_number: 'OB-LIC-001',
    } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('otp_required');
  });

  it('OTP request records an audit row and caches a hashed code (never plaintext)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register/otp/request', payload: { phone: PHONE } });
    expect(res.statusCode).toBe(200);
    const cached = fake.map.get(`otp:${PHONE}`);
    expect(cached).toBeTruthy();
    // cacheSetJson JSON-encodes the string -> strip quotes before matching.
    expect(String(cached!.v).replace(/"/g, '')).toHaveLength(64); // sha256 hex only
    expect(String(cached!.v).replace(/"/g, '')).toMatch(/^[0-9a-f]{64}$/);
    const { rows } = await poolX.query(`SELECT purpose FROM otp_requests WHERE phone_e164 = $1`, [PHONE]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('registers once: no password, Unassigned Fleet, PENDING_REVIEW, device paired, token issued', async () => {
    putOtp(PHONE, '123456');
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: {
      phone: PHONE, otp_code: '123456', device_id: DEVICE, full_name: 'Ovg Driver',
      license_number: 'OB-LIC-001', license_class: 'C', association_name: 'Adama Truck Owners',
      vehicle: { plate_number: 'OB-3001', body_type: 'LOW_BED', ownership_status: 'OWNER' },
      trailers: [{ plate_number: 'OB-T-01', trailer_type: 'low bed' }],
    } });
    expect([200, 201]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('PENDING_REVIEW');
    expect(body.access_token).toBeTruthy();
    driverId = body.driver.id;

    const { rows } = await poolX.query(
      `SELECT u.password_hash, u.fleet_id, f.name AS fleet, u.phone_e164,
              p.license_number, p.association_name
         FROM users u JOIN fleets f ON f.id = u.fleet_id
         LEFT JOIN driver_profiles p ON p.driver_id = u.id WHERE u.id = $1`, [driverId]);
    expect(rows[0].password_hash).toBeNull();           // drivers NEVER have a password
    expect(rows[0].fleet).toBe('Unassigned Fleet');     // pending admin activation
    expect(rows[0].license_number).toBe('OB-LIC-001');
    const { rows: dev } = await poolX.query(
      `SELECT revoked_at FROM device_identities WHERE user_id = $1 AND device_id = $2`, [driverId, DEVICE]);
    expect(dev.length).toBe(1);
    expect(dev[0].revoked_at).toBeNull();
  });

  it('the same OTP code cannot be replayed (one-shot)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: {
      phone: PHONE, otp_code: '123456', device_id: DEVICE, full_name: 'Ovg Driver',
      license_number: 'OB-LIC-001',
    } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('otp_expired_or_invalid');
  });

  /* ------------------------ 2. No recurring login model ----------------------- */

  it('session refresh replaces login: valid pairing ⇒ new token, no credentials', async () => {
    // Mint an expired-style call first WITHOUT a bearer: 401 (must pair/register).
    const anon = await app.inject({ method: 'POST', url: '/auth/session/refresh',
      payload: { device_id: DEVICE } });
    expect(anon.statusCode).toBe(401);

    const { signAccessToken } = await import('../src/lib/jwt.js');
    const oldToken = signAccessToken({ sub: driverId, role: 'DRIVER', fleetId: UF_FIXED });
    const res = await app.inject({ method: 'POST', url: '/auth/session/refresh',
      headers: { authorization: `Bearer ${oldToken}` }, payload: { device_id: DEVICE } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).access_token).toBeTruthy();
  });

  it('unknown device ⇒ refresh denied with device_not_paired', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const token = signAccessToken({ sub: driverId, role: 'DRIVER', fleetId: UF_FIXED });
    const res = await app.inject({ method: 'POST', url: '/auth/session/refresh',
      headers: { authorization: `Bearer ${token}` }, payload: { device_id: 'not-a-real-device-install' } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('device_not_paired');
  });

  it('re-registration with the SAME phone reuses the person-account (identity ≠ plate)', async () => {
    putOtp(PHONE, '654321');
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: {
      phone: PHONE, otp_code: '654321', device_id: DEVICE, full_name: 'Ovg Driver Renamed',
      license_number: 'OB-LIC-001',
      vehicle: { plate_number: 'OB-3002', body_type: 'HIGH_BED' }, // changed truck
    } });
    expect(res.statusCode).toBe(200); // 200 = repaired, not 201 = created
    const body = JSON.parse(res.body);
    expect(body.driver.id).toBe(driverId);
    const { rows } = await poolX.query(`SELECT COUNT(*)::int n FROM users WHERE phone_e164 = $1`, [PHONE]);
    expect(rows[0].n).toBe(1); // still ONE account for the person
    // Time-bound history: old truck closed, new truck active, both kept.
    const { rows: hist } = await poolX.query(
      `SELECT v.plate_number, va.unassigned_at FROM driver_vehicle_assignments va
        JOIN vehicles v ON v.id = va.vehicle_id WHERE va.driver_id = $1 ORDER BY va.assigned_at`, [driverId]);
    expect(hist.length).toBe(2);
    expect(hist[0].unassigned_at).not.toBeNull();
    expect(hist[1].plate_number).toBe('OB-3002');
    expect(hist[1].unassigned_at).toBeNull();
  });

  /* ------------------------- 3. Profile & documents --------------------------- */

  it('driver profile endpoints: GET/PATCH /me/profile, add trailer, list devices', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const token = signAccessToken({ sub: driverId, role: 'DRIVER', fleetId: UF_FIXED });
    const H = { authorization: `Bearer ${token}` };

    const patch = await app.inject({ method: 'PATCH', url: '/me/profile', headers: H,
      payload: { home_base: 'Adama', ownership_status: 'LEASED' } });
    expect(patch.statusCode).toBe(200);

    const prof = await app.inject({ method: 'GET', url: '/me/profile', headers: H });
    expect(prof.statusCode).toBe(200);
    const p = JSON.parse(prof.body);
    expect(p.home_base).toBe('Adama');
    expect(p.registration_status).toBe('INCOMPLETE'); // nothing uploaded yet
    expect(p.trailers.length).toBeGreaterThanOrEqual(1);

    const trl = await app.inject({ method: 'POST', url: '/me/trailers', headers: H,
      payload: { plate_number: 'OB-T-02', trailer_type: 'container' } });
    expect(trl.statusCode).toBe(201);

    const devs = await app.inject({ method: 'GET', url: '/me/devices', headers: H });
    expect(JSON.parse(devs.body).devices.length).toBe(1);
  });

  it('document upload: mandatory DRIVING_LICENSE accepted, invalid type rejected', async () => {
    const { signAccessToken } = await import('../src/lib/jwt.js');
    const token = signAccessToken({ sub: driverId, role: 'DRIVER', fleetId: UF_FIXED });
    const boundary = '----obgtestboundary';
    const filePart = (docType: string) => Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="doc_type"\r\n\r\n${docType}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="lic.jpg"\r\n` +
      `Content-Type: image/jpeg\r\n\r\n`);
    const end = Buffer.from(`\r\n--${boundary}--\r\n`);

    const ok = await app.inject({ method: 'POST', url: '/me/documents',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([filePart('DRIVING_LICENSE'), Buffer.from('%JPEGFAKE'), end]) });
    expect(ok.statusCode).toBe(201);
    const doc = JSON.parse(ok.body);
    expect(doc.status).toBe('PENDING_REVIEW');
    expect(doc.mandatory).toBe(true);

    const bad = await app.inject({ method: 'POST', url: '/me/documents',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([filePart('SELFIE'), Buffer.from('%JPEGFAKE'), end]) });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('invalid_doc_type');
  });

  /* -------------------- 4. Admin review + B2B assignment ---------------------- */

  it('admin sees the driver in the PENDING queue and verifies the license', async () => {
    const token = await adminToken();
    const H = { authorization: `Bearer ${token}` };
    const queue = await app.inject({ method: 'GET', url: '/admin/drivers?status=PENDING', headers: H });
    expect(queue.statusCode).toBe(200);
    const found = JSON.parse(queue.body).drivers.find((x: any) => x.id === driverId);
    expect(found).toBeTruthy();
    expect(found.active_vehicle.plate_number).toBe('OB-3002');

    const dossier = await app.inject({ method: 'GET', url: `/admin/drivers/${driverId}`, headers: H });
    const lic = JSON.parse(dossier.body).documents.find((x: any) => x.doc_type === 'DRIVING_LICENSE');
    expect(lic.status).toBe('PENDING_REVIEW');

    const verify = await app.inject({ method: 'PATCH', url: `/admin/documents/${lic.id}/status`,
      headers: H, payload: { status: 'VERIFIED' } });
    expect(verify.statusCode).toBe(200);
    expect(JSON.parse(verify.body).status).toBe('VERIFIED');
  });

  it('admin assigns truck (B2B): created_by_admin=true, previous self-declared assignment closed', async () => {
    const token = await adminToken();
    const H = { authorization: `Bearer ${token}` };
    // Provision a company-owned vehicle in the target fleet. plate_number has
    // a global UNIQUE constraint — an interrupted prior run may have left the
    // row behind, so rebind it (and close its dangling assignments) instead of
    // blindly inserting.
    const vehId = randomUUID();
    await poolX.query(
      `INSERT INTO vehicles (id, plate_number, fleet_id) VALUES ($1,'OB-FLEET-9',$2)
       ON CONFLICT (plate_number) DO NOTHING`, [vehId, FLEET]);
    const { rows: vRow } = await poolX.query(`SELECT id FROM vehicles WHERE plate_number='OB-FLEET-9'`);
    if (vRow[0].id !== vehId) {
      await poolX.query(`UPDATE driver_vehicle_assignments SET unassigned_at = now()
                          WHERE vehicle_id = $1 AND unassigned_at IS NULL`, [vRow[0].id]).catch(() => {});
      await poolX.query(`DELETE FROM audit_log WHERE detail::text LIKE '%' || $1 || '%'`, [vRow[0].id]).catch(() => {});
      await poolX.query(`DELETE FROM vehicles WHERE id = $1`, [vRow[0].id]).catch(() => {});
      await poolX.query(`INSERT INTO vehicles (id, plate_number, fleet_id) VALUES ($1,'OB-FLEET-9',$2)`,
                        [vehId, FLEET]);
    }

    const move = await app.inject({ method: 'POST', url: `/admin/drivers/${driverId}/move`,
      headers: H, payload: { fleet_id: FLEET } });
    expect(move.statusCode).toBe(200);

    const assign = await app.inject({ method: 'POST', url: `/admin/drivers/${driverId}/assign-vehicle`,
      headers: H, payload: { vehicle_id: vehId } });
    expect(assign.statusCode).toBe(201);
    expect(JSON.parse(assign.body).created_by_admin).toBe(true);

    const { rows } = await poolX.query(
      `SELECT count(*) FILTER (WHERE unassigned_at IS NULL AND created_by_admin)::int active_admin,
              count(*) FILTER (WHERE unassigned_at IS NOT NULL)::int closed
         FROM driver_vehicle_assignments WHERE driver_id = $1`, [driverId]);
    expect(rows[0].active_admin).toBe(1);
    expect(rows[0].closed).toBeGreaterThanOrEqual(2);
  });

  it('FLEET_MANAGER cannot verify documents across tenants (fail-closed)', async () => {
    const otherFleet = randomUUID();
    await poolX.query(`INSERT INTO fleets (id, name) VALUES ($1,'OBG Other Fleet')`, [otherFleet]);
    const otherDriver = randomUUID();
    extraUserIds.push(otherDriver);
    await poolX.query(
      `INSERT INTO users (id, role, full_name, phone_e164, locale, fleet_id)
       VALUES ($1,'DRIVER','Other Driver',$2,'en',$3)`,
      [otherDriver, '+251922222222', otherFleet]);
    const docId = randomUUID();
    await poolX.query(
      `INSERT INTO driver_documents (id, driver_id, doc_type, file_path) VALUES ($1,$2,'NATIONAL_ID','/tmp/x.jpg')`,
      [docId, otherDriver]);

    const mgrLogin = await app.inject({ method: 'POST', url: '/auth/login',
      payload: { identifier: `obg-mgr-${MGR.slice(0, 8)}@yet.local`, password: 'obg-mgr-pw' } });
    const mgrToken = JSON.parse(mgrLogin.body).access_token;
    const res = await app.inject({ method: 'PATCH', url: `/admin/documents/${docId}/status`,
      headers: { authorization: `Bearer ${mgrToken}` }, payload: { status: 'VERIFIED' } });
    expect(res.statusCode).toBe(404); // invisible cross-tenant (target_not_found)

    await poolX.query(`DELETE FROM driver_documents WHERE id = $1`, [docId]);
    await poolX.query(`DELETE FROM users WHERE id = $1`, [otherDriver]);
    await poolX.query(`DELETE FROM fleets WHERE id = $1`, [otherFleet]);
  });

  it('driver suspended by admin ⇒ every surface denies immediately (pairing dead)', async () => {
    const token = await adminToken();
    const sus = await app.inject({ method: 'POST', url: `/admin/drivers/${driverId}/suspend`,
      headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(sus.statusCode).toBe(200);

    const { signAccessToken } = await import('../src/lib/jwt.js');
    const drvToken = signAccessToken({ sub: driverId, role: 'DRIVER', fleetId: FLEET });
    const prof = await app.inject({ method: 'GET', url: '/me/profile',
      headers: { authorization: `Bearer ${drvToken}` } });
    expect(prof.statusCode).toBe(403);
    expect(JSON.parse(prof.body).error).toBe('account_inactive');

    const refresh = await app.inject({ method: 'POST', url: '/auth/session/refresh',
      headers: { authorization: `Bearer ${drvToken}` }, payload: { device_id: DEVICE } });
    expect(refresh.statusCode).toBe(403);

    // reactivate for teardown neutrality
    await app.inject({ method: 'POST', url: `/admin/drivers/${driverId}/suspend`,
      headers: { authorization: `Bearer ${token}` }, payload: { active: true } });
  });

  it('device revocation forces re-pairing with OTP (lost-phone path)', async () => {
    const token = await adminToken();
    const rev = await app.inject({ method: 'POST', url: `/admin/drivers/${driverId}/revoke-device`,
      headers: { authorization: `Bearer ${token}` }, payload: { device_id: DEVICE, reason: 'lost phone' } });
    expect(rev.statusCode).toBe(200);

    const { signAccessToken } = await import('../src/lib/jwt.js');
    const drvToken = signAccessToken({ sub: driverId, role: 'DRIVER', fleetId: FLEET });
    const refresh = await app.inject({ method: 'POST', url: '/auth/session/refresh',
      headers: { authorization: `Bearer ${drvToken}` }, payload: { device_id: DEVICE } });
    expect(refresh.statusCode).toBe(403);
    expect(JSON.parse(refresh.body).error).toBe('device_not_paired');

    // Re-pair via OTP — no password anywhere in the flow.
    putOtp(PHONE, '246810');
    const NEWDEV = `dev-new-${randomUUID().slice(0, 8)}`;
    const pair = await app.inject({ method: 'POST', url: '/auth/pair-device', payload: {
      phone: PHONE, otp_code: '246810', device_id: NEWDEV, platform: 'android',
    } });
    expect(pair.statusCode).toBe(200);
    expect(JSON.parse(pair.body).access_token).toBeTruthy();
  });
});
