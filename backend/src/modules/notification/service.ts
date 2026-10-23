/**
 * Module 5 — Notification: queueing service (Phase 5).
 *
 * Owns: notification_templates, notification_log (§1.5) + user_push_tokens (0012).
 * Responsibilities:
 *  1. RECIPIENT RESOLUTION — who must hear about an event for driver X:
 *     the driver themselves (if they carry a push token) plus every active
 *     FLEET_MANAGER/ADMIN. Fleet-wide role broadcast is deliberate at pilot
 *     scale (<10 managers); per-fleet scoping is an Identity-module concern and
 *     listed in docs/ARCHITECTURE.md as an extraction task.
 *  2. TEMPLATE LOOKUP + RENDER — bilingual (Amharic-first §1.2) via kernel.renderMessage.
 *  3. IDEMPOTENT QUEUEING — INSERT ... ON CONFLICT (event_type, dedupe_key) DO
 *     NOTHING against uq_notif_dedupe (migration 0011). Together with the pure
 *     kernel (decideSeparationTimer + notified_fleet_manager marker) this makes
 *     offline replay / repeated window recomputation fire each logical alert
 *     EXACTLY ONCE (§1.8.3 convergence applied to notifications).
 *
 * Delivery itself (FCM/SMS) lives in dispatchers.ts; this file only queues.
 * QUEUED rows are picked up by the dispatcher worker loop.
 */

import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import {
  renderMessage, pickLocale, separationDedupeKey, tripEventDedupeKey,
  SEPARATION_NOTIFY_MIN_DEFAULT, type TemplateVars,
} from './kernel.js';

export type NotificationEventType =
  | 'TRIP_STARTED' | 'TRIP_ENDED' | 'DRIVER_SEPARATION_TIMER'
  | 'GEOFENCE_ENTER' | 'GEOFENCE_EXIT';

type TemplateRow = {
  event_type: string; title_en: string; body_en: string;
  title_am: string; body_am: string; channel: string; fallback: string | null;
};

const templateCache = new Map<string, { row: TemplateRow | null; fetchedAtMs: number }>();
const TEMPLATE_TTL_MS = 60_000; // templates change rarely; keep hot path allocation-free

async function getTemplate(eventType: string): Promise<TemplateRow | null> {
  const hit = templateCache.get(eventType);
  if (hit && Date.now() - hit.fetchedAtMs < TEMPLATE_TTL_MS) return hit.row;
  const { rows } = await pool.query<TemplateRow>(
    `SELECT event_type, title_en, body_en, title_am, body_am, channel::text AS channel,
            fallback::text AS fallback
       FROM notification_templates WHERE event_type = $1 AND active LIMIT 1`,
    [eventType]);
  const row = rows[0] ?? null;
  templateCache.set(eventType, { row, fetchedAtMs: Date.now() });
  return row;
}

type RecipientRow = {
  user_id: string; role: string; locale: string | null;
  phone_e164: string | null; has_token: boolean;
};

/**
 * Resolve recipients for an event triggered by target_user's data.
 * Driver (only when they have registered a push token) + all active managers/admins.
 * Returns SMS-capable flags so the dispatcher can fall back per recipient.
 */
export async function resolveRecipients(targetUserId: string): Promise<RecipientRow[]> {
  const { rows } = await pool.query<RecipientRow>(
    `SELECT u.id AS user_id, u.role::text AS role, u.locale, u.phone_e164,
            EXISTS (SELECT 1 FROM user_push_tokens t WHERE t.user_id = u.id) AS has_token
       FROM users u
      WHERE u.is_active
        AND (u.role IN ('FLEET_MANAGER','ADMIN')
             OR (u.role = 'DRIVER' AND u.id = $1
                 AND EXISTS (SELECT 1 FROM user_push_tokens t WHERE t.user_id = u.id)))
      ORDER BY u.role DESC, u.id`,
    [targetUserId]);
  return rows;
}

export type QueueResult = {
  queued: number;               // recipients newly enqueued (0 => full dedupe no-op)
  skipped_no_template: boolean;
  notifications: { notification_id: string; recipient_id: string; channel: string; status: string }[];
};

/**
 * THE queue entry point. Fire-once semantics come from uq_notif_dedupe:
 * re-calling with the same (event_type, dedupe_key) inserts nothing and returns
 * queued:0 — safe under every replay/recompute (§1.8.2/§1.8.3 pattern).
 *
 * Fan-out shape: ONE ledger row per recipient, keyed `dedupeKey + '@' + userId`.
 * (event_type, dedupe_key) uniqueness therefore gives PER-RECIPIENT idempotency
 * directly ("the separation alert fires once per manager per incident"), and
 * "did ANY delivery happen for this logical event" is answered by a prefix scan
 * (dedupe_key LIKE 'key@%') in the integration gate. A fully-replayed batch
 * conflicts on every recipient row and queues nothing again — no separate claim
 * layer needed, and each recipient's rendered title/locale is recorded in the
 * redacted detail JSONB (never coordinates — PDPP §1.7 minimization).
 */
export async function enqueueNotification(params: {
  eventType: NotificationEventType;
  dedupeKey: string;
  targetUserId: string;
  vars: TemplateVars;
  detail?: Record<string, unknown>;   // redacted metadata only (trip_id, vehicle_id…) — PDPP
}): Promise<QueueResult> {
  const template = await getTemplate(params.eventType);
  if (!template) return { queued: 0, skipped_no_template: true, notifications: [] };

  // Layer — per-recipient fan-out rows (real delivery work items). One ledger
  // row each, dedupe_key = `${key}@${recipientId}` for per-recipient idempotency.
  const recipients = await resolveRecipients(params.targetUserId);
  const out: QueueResult['notifications'] = [];
  for (const r of recipients) {
    // Channel choice: FCM when a token exists; else SMS when template allows it
    // and the manager has a phone number; else stay FCM (dispatcher records
    // UNREGISTERED → SKIPPED, keeping the audit trail complete).
    let channel = template.channel;
    if (channel === 'FCM' && !r.has_token) {
      channel = (template.fallback === 'SMS' && r.phone_e164) ? 'SMS' : 'FCM';
    }
    const msg = renderMessage(template, pickLocale(r.locale), params.vars);
    const { rows } = await pool.query(
      `INSERT INTO notification_log
         (event_type, dedupe_key, recipient_role, recipient_id, target_user, channel, status, detail)
       VALUES ($1,$2,$3::user_role,$4,$5,$6::notification_channel,'QUEUED',$7::jsonb)
       ON CONFLICT (event_type, dedupe_key) DO NOTHING
       RETURNING notification_id, channel::text AS channel, status::text AS status`,
      [params.eventType, `${params.dedupeKey}@${r.user_id}`, r.role, r.user_id,
       params.targetUserId, channel,
       JSON.stringify({ ...params.detail, title: msg.title, locale: msg.locale })]);
    if (rows[0]) out.push({ notification_id: rows[0].notification_id, recipient_id: r.user_id,
                            channel: rows[0].channel, status: rows[0].status });
  }
  await audit({ action: 'notification_queued', targetUser: params.targetUserId,
                detail: { event_type: params.eventType, dedupe_key: params.dedupeKey, queued: out.length } });
  return { queued: out.length, skipped_no_template: false, notifications: out };
}

/* ---------------------------------------------------------------------------
 * Convenience wrappers used by the composition-root trigger wiring.
 * ------------------------------------------------------------------------- */

export function tripNotifierDedupe(tripId: string, eventType: 'TRIP_STARTED' | 'TRIP_ENDED' | 'GEOFENCE_ENTER' | 'GEOFENCE_EXIT', tsMs: number): string {
  return tripEventDedupeKey(tripId, eventType, tsMs);
}

export async function notifyTripEvent(params: {
  eventType: 'TRIP_STARTED' | 'TRIP_ENDED';
  tripId: string; driverId: string; vehicleId: string; plateNumber: string | null;
  eventTimestampMs: number; distanceM?: number | null;
}): Promise<number> {
  const res = await enqueueNotification({
    eventType: params.eventType,
    dedupeKey: tripEventDedupeKey(params.tripId, params.eventType, params.eventTimestampMs),
    targetUserId: params.driverId,
    vars: {
      plate: params.plateNumber ?? '—',
      distance_km: params.distanceM != null ? (params.distanceM / 1000).toFixed(1) : '',
    },
    detail: { trip_id: params.tripId, vehicle_id: params.vehicleId, template: params.eventType },
  });
  return res.queued;
}

export async function notifyGeofenceCrossing(params: {
  eventType: 'GEOFENCE_ENTER' | 'GEOFENCE_EXIT';
  tripId: string; driverId: string; vehicleId: string; plateNumber: string | null;
  geofenceName: string; eventTimestampMs: number;
}): Promise<number> {
  const res = await enqueueNotification({
    eventType: params.eventType,
    dedupeKey: tripEventDedupeKey(params.tripId, params.eventType, params.eventTimestampMs),
    targetUserId: params.driverId,
    vars: { plate: params.plateNumber ?? '—', zone: params.geofenceName },
    detail: { trip_id: params.tripId, vehicle_id: params.vehicleId, template: params.eventType },
  });
  return res.queued;
}

export async function notifySeparationTimer(params: {
  separationId: string; driverId: string; vehicleId: string; plateNumber: string | null;
  minutesSince: number;
}): Promise<number> {
  const thresholdMin = env.TRIP_SEPARATION_NOTIFY_MIN || SEPARATION_NOTIFY_MIN_DEFAULT;
  const res = await enqueueNotification({
    eventType: 'DRIVER_SEPARATION_TIMER',
    dedupeKey: separationDedupeKey(params.separationId),
    targetUserId: params.driverId,
    vars: { plate: params.plateNumber ?? '—', minutes: String(thresholdMin) },
    detail: { separation_id: params.separationId, vehicle_id: params.vehicleId, template: 'DRIVER_SEPARATION_TIMER' },
  });
  return res.queued;
}

/** Test/diagnostic helper — clear the short template cache (used by integration harness). */
export function invalidateTemplateCache(): void { templateCache.clear(); }
