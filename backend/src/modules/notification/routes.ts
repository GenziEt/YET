import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { verifyAccessToken } from '../../lib/jwt.js';
import { audit } from '../../lib/audit.js';
import { env, isProd } from '../../config/env.js';
import { dispatchQueuedOnce } from './dispatchers.js';
import { runSeparationSweep } from './triggers.js';

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

async function bearer(req: any): Promise<{ sub: string; role: string }> {
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
    const { rows } = await pool.query(
      `SELECT notification_id, event_type, dedupe_key, recipient_role::text AS recipient_role,
              recipient_id, target_user, channel::text AS channel, status::text AS status,
              provider_msg_id, error_code, created_at, sent_at
         FROM notification_log
        WHERE ($1::uuid IS NULL OR target_user = $1)
          AND ($2::text IS NULL OR event_type = $2)
          AND ($3::text IS NULL OR status::text = $3)
        ORDER BY created_at DESC
        LIMIT $4`,
      [q.data.target_user ?? null, q.data.event_type ?? null, q.data.status ?? null, q.data.limit],
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
    app.post('/notifications/sweep/run', async (req) => {
      const claims = await bearer(req); // any authenticated user; audited
      const sweep = await runSeparationSweep();
      const dispatch = await dispatchQueuedOnce();
      await audit({ actorId: claims.sub, action: 'notification_sweep_run', ip: req.ip,
                    detail: { ...sweep, ...dispatch, dry_run: process.env.NOTIFY_DISPATCH_DRY_RUN === 'true' || !env.FCM_PROJECT } });
      return { sweep, dispatch };
    });
  }
}
