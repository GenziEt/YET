import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { verifyAccessToken, type TokenClaims } from '../../lib/jwt.js';
import { audit } from '../../lib/audit.js';
import { env, isProd } from '../../config/env.js';
import { scopeFleetId } from '../../lib/tenant.js';
import { dispatchQueuedOnce } from './dispatchers.js';
import { runSeparationSweep, testForceSeparationOverdue, testSeparationDedupeKeys } from './triggers.js';

/**
 * Module 5 — Notification HTTP surface (Phase 5).
 *
 *  - POST /notifications/token      DRIVER: register this device's FCM token.
 *    Token is UNIQUE globally (migration 0012): a phone handed between drivers
 *    UPSERTS the row to the new owner — stale claims on old assignments are
 *    impossible, which is exactly what prevents alert leakage on reassignment.
 *  - GET  /notifications/log        FLEET_MANAGER/ADMIN: delivery ledger read.
 *    Audited (§1.7) — the ledger itself is personal-data metadata (who was told
 *    what about whom), so every access lands in audit_log.
 *  - POST /notifications/sweep/run  TEST-ONLY manual trigger of the separation
 *    timer + dispatcher pass, so integration gates don't wait for the loops.
 */

async function bearer(req: any): Promise<TokenClaims> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
  return verifyAccessToken(header.slice(7));
}

const TokenSchema = z.object({
  token: z.string().min(20).max(4096),          // FCM v1 registration token shape
  platform: z.enum(['android', 'ios', 'web']).default('android'),
  device_id: z.string().max(128).optional(),
  locale: z.enum(['en', 'am']).optional(),
});

export default async function notificationRoutes(app: FastifyInstance) {
  /** Register/refresh the caller's push token. Idempotent UPSERT per token. */
  app.post('/notifications/token', async (req, reply) => {
    const claims = await bearer(req);
    if (claims.role !== 'DRIVER' && claims.role !== 'FLEET_MANAGER' && claims.role !== 'ADMIN')
      throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
    const parsed = TokenSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload', detail: parsed.error.flatten() });

    const { rows } = await pool.query(
      `INSERT INTO user_push_tokens (user_id, token, platform, device_id, locale, last_seen_at)
       VALUES ($1,$2,$3::text,$4,$5, now())
       ON CONFLICT (token) DO UPDATE SET
         user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
         device_id = EXCLUDED.device_id, locale = EXCLUDED.locale, last_seen_at = now()
       RETURNING token_id`,
      [claims.sub, parsed.data.token, parsed.data.platform, parsed.data.device_id ?? null, parsed.data.locale ?? null],
    );
    await audit({ actorId: claims.sub, action: 'push_token_registered', targetUser: claims.sub, ip: req.ip,
                  detail: { token_id: rows[0]?.token_id, platform: parsed.data.platform } });
    return reply.code(201).send({ registered: true, token_id: rows[0].token_id });
  });

  /** Delivery-ledger read for managers: recent rows, optional filters. */
  app.get('/notifications/log', async (req, reply) => {
    const claims = await bearer(req);
    if (claims.role !== 'FLEET_MANAGER' && claims.role !== 'ADMIN')
      throw Object.assign(new Error('forbidden_role'), { statusCode: 403 });
    const q = z.object({
      target_user: z.string().uuid().optional(),
      event_type: z.enum(['TRIP_STARTED', 'TRIP_ENDED', 'DRIVER_SEPARATION_TIMER', 'GEOFENCE_ENTER', 'GEOFENCE_EXIT']).optional(),
      status: z.enum(['QUEUED', 'SENT', 'FAILED', 'SKIPPED']).optional(),
      limit: z.coerce.number().int().positive().max(500).default(100),
    }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_query', detail: q.error.flatten() });
    // Tenant boundary (Phase 0 rule applied to a Phase 5 surface): the ledger is
    // personal-data metadata, so a FLEET_MANAGER may only read rows whose TARGET
    // driver belongs to their fleet. ADMIN sees the platform. scopeFleetId()
    // fails closed (403 cross_fleet_denied) for tenant tokens lacking a fleet
    // claim; covered by the negative test in tests/phase5_gates.test.ts.
    const fleetScope = scopeFleetId(claims);
    const { rows } = await pool.query(
      `SELECT notification_id, event_type, dedupe_key, recipient_role::text AS recipient_role,
              recipient_id, target_user, channel::text AS channel, status::text AS status,
              provider_msg_id, error_code, created_at, sent_at
         FROM notification_log nl
        WHERE ($1::uuid IS NULL OR target_user = $1)
          AND ($2::text IS NULL OR event_type = $2)
          AND ($3::text IS NULL OR status::text = $3)
          AND ($5::uuid IS NULL OR EXISTS (
                SELECT 1 FROM users tu WHERE tu.id = nl.target_user AND tu.fleet_id = $5))
        ORDER BY created_at DESC
        LIMIT $4`,
      [q.data.target_user ?? null, q.data.event_type ?? null, q.data.status ?? null, q.data.limit,
       fleetScope ?? null],
    );
    await audit({ actorId: claims.sub, action: 'read_notification_log', targetUser: q.data.target_user ?? null,
                  ip: req.ip, detail: { count: rows.length, filter: q.data } });
    return { count: rows.length, notifications: rows };
  });

  /**
   * Test-mode harness: run one separation-sweep pass + one dispatcher pass and
   * report counters. NEVER mounted in production — the periodic loops own this
   * cadence there, and an operator-triggerable "notify now" endpoint over
   * personal-data triggers is not something to ship to the open internet.
   */
  if (!isProd) {
    app.post('/notifications/sweep/run', async (req, reply) => {
      const claims = await bearer(req); // any authenticated user; audited
      // TEST-ONLY pre-step (§1.8.3 gate): the harness may pass a separation_id to
      // mark overdue so the sweep FIRES within seconds instead of waiting out the
      // real TRIP_SEPARATION_NOTIFY_MIN wall clock. Guarded by the same WHERE as
      // the sweep's own claim filter, so it can never touch notified/closed rows.
      let forced: { shifted: boolean } | null = null;
      const body = (req.body ?? {}) as { separation_id?: string };
      if (body.separation_id) {
        const parsed = z.object({ separation_id: z.string().uuid() }).safeParse(body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
        forced = await testForceSeparationOverdue(parsed.data.separation_id);
      }
      const sweep = await runSeparationSweep();
      const dispatch = await dispatchQueuedOnce();
      await audit({ actorId: claims.sub, action: 'notification_sweep_run', ip: req.ip,
                    detail: { ...sweep, ...dispatch, forced, dry_run: process.env.NOTIFY_DISPATCH_DRY_RUN === 'true' || !env.FCM_PROJECT } });
      return { sweep, dispatch, forced };
    });

    /** Test-mode read: per-recipient dedupe keys queued for one incident — lets
     *  the integration gate assert `${sep:id}@${userId}` fan-out shape. */
    app.get('/notifications/test/dedupe-keys/:separation_id', async (req, reply) => {
      await bearer(req);
      const p = z.object({ separation_id: z.string().uuid() }).safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'invalid_params' });
      return { keys: await testSeparationDedupeKeys(p.data.separation_id) };
    });
  }
}
