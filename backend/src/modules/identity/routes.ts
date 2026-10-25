import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { pool } from '../../db/pool.js';
import { signAccessToken, verifyAccessToken } from '../../lib/jwt.js';
import { audit } from '../../lib/audit.js';
import { env, isProd } from '../../config/env.js';
import {
  CURRENT_CONSENT_POLICY, CONSENT_POLICY_VERSIONS, isValidPolicyVersion,
  revokeSupersededConsents,
} from './consent.js';

// ---- validation schemas -------------------------------------------------------
const LoginSchema = z.object({
  identifier: z.string().min(3),            // phone_e164 or email
  password: z.string().min(8),
});

const ConsentScope = z.enum(['location', 'motion', 'audio']);
const BootstrapSchema = z.object({
  identifier: z.string().min(3),                  // phone_e164 or email of pre-provisioned driver
  password: z.string().min(8),
  device_id: z.string().min(8).max(128),          // stable per-install UUID from the app
});
const ConsentSchema = z.object({
  policy_version: z.string().min(1),
  locale: z.enum(['en', 'am']),
  granted_scopes: z.array(ConsentScope).min(2), // location+motion mandatory set (§1.7 minimization)
  device_id: z.string().optional(),
  app_version: z.string().optional(),
});

// Password hashing without native deps (low-end server constraint parity): scrypt.
function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(pw: string, stored: string): boolean {
  const [tag, saltHex, keyHex] = stored.split('$');
  if (tag !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

async function authGuard(req: FastifyRequest): Promise<{ id: string; role: string }> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const claims = verifyAccessToken(header.slice(7));
  return { id: claims.sub, role: claims.role };
}

export default async function identityRoutes(app: FastifyInstance) {
  /** POST /auth/login — JWT access token. Rate-limited at nginx + in-app. */
  app.post('/auth/login', async (req, reply) => {
    const body = LoginSchema.parse(req.body);
    const { rows } = await pool.query(
      `SELECT id, role, password_hash, locale, is_active, fleet_id FROM users
       WHERE phone_e164 = $1 OR email = $2 LIMIT 1`,
      [body.identifier, body.identifier],
    );
    const user = rows[0];
    if (!user || !user.is_active || !verifyPassword(body.password, user.password_hash)) {
      await audit({ action: 'login_failed', ip: req.ip });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    // Tenant check (Phase 0): a suspended fleet's members cannot authenticate.
    if (user.fleet_id) {
      const { rows: fl } = await pool.query(`SELECT status FROM fleets WHERE id = $1`, [user.fleet_id]);
      if (fl[0]?.status !== 'ACTIVE') {
        await audit({ actorId: user.id, action: 'login_denied_fleet_suspended', targetUser: user.id, ip: req.ip });
        return reply.code(403).send({ error: 'fleet_suspended' });
      }
    }
    await audit({ actorId: user.id, action: 'login', targetUser: user.id, ip: req.ip });
    const token = signAccessToken({ sub: user.id, role: user.role, locale: user.locale, fleetId: user.fleet_id ?? undefined });
    return { access_token: token, role: user.role, locale: user.locale, fleet_id: user.fleet_id ?? null };
  });

  /**
   * POST /consent — Phase 0 gate: backend records driver consent (PDPP §1.7).
   * Requires an authenticated driver token. Idempotent per (driver, policy_version):
   * re-accepting the same version updates scopes rather than duplicating history.
   * The accepted version MUST exist in the registry (consent.ts) and must be the
   * CURRENT one — a client cannot "consent" to a superseded/unknown policy.
   */
  app.post('/consent', async (req, reply) => {
    const auth = await authGuard(req);
    const body = ConsentSchema.parse(req.body);
    if (!isValidPolicyVersion(body.policy_version)) {
      return reply.code(400).send({ error: 'unknown_policy_version', current: CURRENT_CONSENT_POLICY.id });
    }
    if (body.policy_version !== CURRENT_CONSENT_POLICY.id) {
      // Superseded text can no longer be granted — force the app to re-render.
      return reply.code(409).send({ error: 'consent_superseded', current: CURRENT_CONSENT_POLICY.id });
    }
    const missing = CURRENT_CONSENT_POLICY.requiredScopes.filter((s) => !body.granted_scopes.includes(s));
    if (missing.length > 0) {
      return reply.code(400).send({ error: 'missing_required_scopes', missing });
    }
    const { rows } = await pool.query(
      `INSERT INTO consent_records (driver_id, policy_version, locale, granted_scopes, device_id, app_version, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT ON CONSTRAINT uq_consent_driver_version DO UPDATE
         SET granted_scopes = EXCLUDED.granted_scopes, revoked_at = NULL
       RETURNING id, granted_at`,
      [auth.id, body.policy_version, body.locale, body.granted_scopes,
       body.device_id ?? null, body.app_version ?? null, req.ip],
    );
    // Policy-change invalidation: stamp any grants for superseded versions so the
    // DB reflects that only the current grant is valid (idempotent, all drivers).
    await revokeSupersededConsents();
    await audit({ actorId: auth.id, action: 'consent_granted', targetUser: auth.id, ip: req.ip,
                  detail: { scopes: body.granted_scopes, policy: body.policy_version } });
    return reply.code(201).send({ consent_id: rows[0].id, granted_at: rows[0].granted_at });
  });

  /** GET /consent/current — driver checks whether they must re-consent (policy bump). */
  app.get('/consent/current', async (req) => {
    const auth = await authGuard(req);
    const { rows } = await pool.query(
      `SELECT policy_version, locale, granted_scopes, granted_at, revoked_at
       FROM consent_records WHERE driver_id = $1 ORDER BY granted_at DESC LIMIT 1`,
      [auth.id],
    );
    const record = rows[0] ?? null;
    const required = !record || !!record.revoked_at || record.policy_version !== CURRENT_CONSENT_POLICY.id;
    return { current_policy: CURRENT_CONSENT_POLICY.id, required };
  });

  /**
   * GET /consent/policy — public metadata of the consent-policy lifecycle so the
   * driver app renders the correct text/version without a hard-coded constant.
   * Non-sensitive (no personal data), therefore unauthenticated by design.
   */
  app.get('/consent/policy', async () => ({
    current: CURRENT_CONSENT_POLICY.id,
    released_at: CURRENT_CONSENT_POLICY.releasedAt,
    required_scopes: CURRENT_CONSENT_POLICY.requiredScopes,
    optional_scopes: CURRENT_CONSENT_POLICY.optionalScopes,
    history: CONSENT_POLICY_VERSIONS.map((v) => ({ id: v.id, released_at: v.releasedAt })),
  }));

  /** POST /consent/revoke — withdrawal path (PDPP §1.7). Stops ingest at once:
   *  the collection guard sees revoked_at and returns 403 consent_required. */
  app.post('/consent/revoke', async (req) => {
    const auth = await authGuard(req);
    const { rowCount } = await pool.query(
      `UPDATE consent_records SET revoked_at = now()
        WHERE driver_id = $1 AND revoked_at IS NULL`, [auth.id]);
    await audit({ actorId: auth.id, action: 'consent_revoked', targetUser: auth.id, ip: req.ip,
                  detail: { rows_revoked: rowCount } });
    return { revoked: true, as_of: new Date().toISOString() };
  });

  /** POST /me/bootstrap — one-time pairing of a pre-provisioned driver account.
   *  Body carries the login identifier (phone_e164 or email) + password; on success
   *  returns a JWT and stamps the device_id onto the user record so later logins can
   *  be recognized. The app stores ONLY the token — never the password. */
  app.post('/me/bootstrap', async (req, reply) => {
    const body = BootstrapSchema.parse(req.body);
    const { rows } = await pool.query(
      `SELECT id, role, password_hash, locale, is_active, fleet_id FROM users
       WHERE phone_e164 = $1 OR email = $2 LIMIT 1`,
      [body.identifier, body.identifier],
    );
    const user = rows[0];
    if (!user || !user.is_active || !verifyPassword(body.password, user.password_hash)) {
      await audit({ action: 'bootstrap_failed', ip: req.ip });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    if (body.device_id) {
      await pool.query(`UPDATE users SET device_id = $2 WHERE id = $1`, [user.id, body.device_id]);
    }
    await audit({ actorId: user.id, action: 'bootstrap_pair', targetUser: user.id, ip: req.ip });
    // Tenant claim must be stamped here too — a bootstrap token without fleet_id
    // would be fail-closed (403) on every scoped read (lib/tenant.ts).
    const token = signAccessToken({ sub: user.id, role: user.role, locale: user.locale, fleetId: user.fleet_id ?? undefined });
    return { access_token: token, role: user.role, locale: user.locale, user_id: user.id, fleet_id: user.fleet_id ?? null };
  });

  /* ---------------- Fleet provisioning (Phase 0 tenant management) ---------------- */

  /** GET /fleets — list tenants. FLEET_MANAGER sees only their own fleet row;
   *  ADMIN sees all. Drivers have no legitimate need for tenant metadata (§1.7). */
  app.get('/fleets', async (req, reply) => {
    const auth = await authGuard(req);
    if (auth.role === 'DRIVER') return reply.code(403).send({ error: 'forbidden_role' });
    if (auth.role === 'ADMIN') {
      const { rows } = await pool.query(
        `SELECT f.id, f.name, f.status, f.agreement_ref, f.created_at,
                (SELECT COUNT(*)::int FROM users u WHERE u.fleet_id = f.id) AS member_count,
                (SELECT COUNT(*)::int FROM vehicles v WHERE v.fleet_id = f.id) AS vehicle_count
           FROM fleets f ORDER BY f.name`);
      return { count: rows.length, fleets: rows };
    }
    const { rows } = await pool.query(
      `SELECT f.id, f.name, f.status, f.agreement_ref, f.created_at,
              (SELECT COUNT(*)::int FROM users u WHERE u.fleet_id = f.id) AS member_count,
              (SELECT COUNT(*)::int FROM vehicles v WHERE v.fleet_id = f.id) AS vehicle_count
         FROM fleets f JOIN users me ON me.id = $1 AND me.fleet_id = f.id`, [auth.id]);
    return { count: rows.length, fleets: rows };
  });

  /** POST /fleets — provision a new tenant (ADMIN only). */
  app.post('/fleets', async (req, reply) => {
    const auth = await authGuard(req);
    if (auth.role !== 'ADMIN') return reply.code(403).send({ error: 'forbidden_role' });
    const body = z.object({
      name: z.string().min(2).max(200),
      agreement_ref: z.string().min(1).max(200).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', detail: body.error.flatten() });
    const { rows } = await pool.query(
      `INSERT INTO fleets (name, agreement_ref) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING RETURNING id, name, status, agreement_ref, created_at`,
      [body.data.name, body.data.agreement_ref ?? null]);
    if (rows.length === 0) return reply.code(409).send({ error: 'fleet_name_exists' });
    await audit({ actorId: auth.id, action: 'fleet_created', ip: req.ip, detail: { fleet_id: rows[0].id, name: rows[0].name } });
    return reply.code(201).send(rows[0]);
  });

  /** PATCH /fleets/:fleet_id/status — suspend/reactivate a tenant (ADMIN only).
   *  SUSPENDED ⇒ login denial (see /auth/login) and ingest denial (ingest routes). */
  app.patch('/fleets/:fleet_id/status', async (req, reply) => {
    const auth = await authGuard(req);
    if (auth.role !== 'ADMIN') return reply.code(403).send({ error: 'forbidden_role' });
    const params = z.object({ fleet_id: z.string().uuid() }).safeParse(req.params);
    const body = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    const { rows } = await pool.query(
      `UPDATE fleets SET status = $2 WHERE id = $1 RETURNING id, name, status`,
      [params.data.fleet_id, body.data.status]);
    if (rows.length === 0) return reply.code(404).send({ error: 'fleet_not_found' });
    await audit({ actorId: auth.id, action: 'fleet_status_changed', ip: req.ip,
                  detail: { fleet_id: rows[0].id, status: rows[0].status } });
    return rows[0];
  });

  /** GET /me — token sanity check used by app bootstrap. */
  app.get('/me', async (req) => {
    const auth = await authGuard(req);
    const { rows } = await pool.query(
      `SELECT id, role, full_name, locale, phone_e164 FROM users WHERE id=$1`, [auth.id]);
    const me = rows[0] ?? null;
    if (!me) return null;
    // Phase 1: the driver app needs its active vehicle to stamp batches/trip UI.
    const { rows: asg } = await pool.query(
      `SELECT va.vehicle_id, v.plate_number, v.fleet_name
         FROM driver_vehicle_assignments va
         JOIN vehicles v ON v.id = va.vehicle_id
        WHERE va.driver_id = $1 AND va.unassigned_at IS NULL
        LIMIT 1`, [auth.id]);
    return { ...me, vehicle: asg[0] ?? null };
  });
}

/** Bootstrap admin/fleet accounts at migrate time (dev convenience; ops runbook covers prod). */
export async function ensureBootstrapAdmin() {
  if (!env.ADMIN_BOOTSTRAP_EMAIL || !env.ADMIN_BOOTSTRAP_PASSWORD) return;
  await pool.query(
    `INSERT INTO users (role, full_name, email, password_hash)
     VALUES ('ADMIN', 'YET Admin', $1, $2) ON CONFLICT (email) DO NOTHING`,
    [env.ADMIN_BOOTSTRAP_EMAIL, hashPassword(env.ADMIN_BOOTSTRAP_PASSWORD)],
  );
}

/**
 * Phase 1 dev/test seed: a DRIVER + vehicle + active assignment so the ingest gate
 * (airplane-mode replay, duplicate batch) is reproducible without manual SQL.
 * NEVER enabled in production — real drivers are provisioned by a fleet manager.
 */
export async function ensureSeedDevDriver() {
  if (isProd) return;
  // Tenant first: the users trigger (migration 0013) rejects a DRIVER/FLEET_MANAGER
  // without fleet_id, so "Pilot Fleet" must exist before the seed driver.
  const { rows: fleetRows } = await pool.query(
    `INSERT INTO fleets (name) VALUES ('Pilot Fleet')
     ON CONFLICT (name) DO UPDATE SET status = 'ACTIVE'
     RETURNING id`,
  );
  const pilotFleetId = fleetRows[0].id as string;
  const { rows } = await pool.query(
    `INSERT INTO users (role, full_name, phone_e164, password_hash, locale, fleet_id)
     VALUES ('DRIVER', 'Test Driver A', '+251900000001', $1, 'am', $2)
     ON CONFLICT (phone_e164)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, fleet_id = EXCLUDED.fleet_id
     RETURNING id`,
    [hashPassword('dev-driver-secret'), pilotFleetId],
  );
  const driverId = rows[0].id as string;
  const { rows: veh } = await pool.query(
    `INSERT INTO vehicles (plate_number, fleet_name, vehicle_type, fleet_id)
     VALUES ('AA-90001', 'Pilot Fleet', 'TRUCK', $1)
     ON CONFLICT (plate_number) DO UPDATE SET fleet_name = EXCLUDED.fleet_name, fleet_id = EXCLUDED.fleet_id
     RETURNING id`,
    [pilotFleetId],
  );
  await pool.query(
    `INSERT INTO driver_vehicle_assignments (driver_id, vehicle_id)
     SELECT $1, $2
     WHERE NOT EXISTS (SELECT 1 FROM driver_vehicle_assignments
                       WHERE driver_id=$1 AND unassigned_at IS NULL)`,
    [driverId, veh[0].id],
  );
}
