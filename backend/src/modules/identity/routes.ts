import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { pool } from '../../db/pool.js';
import { signAccessToken, verifyAccessToken } from '../../lib/jwt.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';

// ---- validation schemas -------------------------------------------------------
const LoginSchema = z.object({
  identifier: z.string().min(3),            // phone_e164 or email
  password: z.string().min(8),
});

const ConsentScope = z.enum(['location', 'motion', 'audio']);
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
      `SELECT id, role, password_hash, locale, is_active FROM users
       WHERE phone_e164 = $1 OR email = $2 LIMIT 1`,
      [body.identifier, body.identifier],
    );
    const user = rows[0];
    if (!user || !user.is_active || !verifyPassword(body.password, user.password_hash)) {
      await audit({ action: 'login_failed', ip: req.ip });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    await audit({ actorId: user.id, action: 'login', targetUser: user.id, ip: req.ip });
    const token = signAccessToken({ sub: user.id, role: user.role, locale: user.locale });
    return { access_token: token, role: user.role, locale: user.locale };
  });

  /**
   * POST /consent — Phase 0 gate: backend records driver consent (PDPP §1.7).
   * Requires an authenticated driver token. Idempotent per (driver, policy_version):
   * re-accepting the same version updates scopes rather than duplicating history.
   */
  app.post('/consent', async (req, reply) => {
    const auth = await authGuard(req);
    const body = ConsentSchema.parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO consent_records (driver_id, policy_version, locale, granted_scopes, device_id, app_version, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT ON CONSTRAINT uq_consent_driver_version DO UPDATE
         SET granted_scopes = EXCLUDED.granted_scopes, revoked_at = NULL
       RETURNING id, granted_at`,
      [auth.id, body.policy_version, body.locale, body.granted_scopes,
       body.device_id ?? null, body.app_version ?? null, req.ip],
    );
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
    return { current_policy: 'consent-v1', record: rows[0] ?? null,
             required: !rows[0] || rows[0].revoked_at || rows[0].policy_version !== 'consent-v1' };
  });

  /** GET /me — token sanity check used by app bootstrap. */
  app.get('/me', async (req) => {
    const auth = await authGuard(req);
    const { rows } = await pool.query(
      `SELECT id, role, full_name, locale, phone_e164 FROM users WHERE id=$1`, [auth.id]);
    return rows[0] ?? null;
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
