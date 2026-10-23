/**
 * Module 5 — Notification: delivery dispatchers (Phase 5).
 *
 * Picks up QUEUED rows from notification_log and delivers them:
 *   FCM  → Firebase Cloud Messaging HTTP v1 (OAuth2 service-account JWT signed
 *          with node:crypto — RS256 via crypto.sign, no google-auth-library
 *          dependency, keeping the low-end-server constraint §1.2 honest).
 *   SMS  → local Ethiopian gateway POST (SMS_GATEWAY_URL) for fleet managers
 *          who do not install the mobile app (Phase 5 deliverable).
 *
 * DRY-RUN mode: when FCM_PROJECT / credentials are absent (dev, pre-pilot),
 * sendFcm returns { ok:true, dryRun:true } and the row is marked SENT with
 * provider_msg_id='dry-run' — the FULL pipeline (template→queue→pickup→status
 * transitions) executes and is integration-testable without touching Google.
 * Set NOTIFY_DISPATCH_DRY_RUN=true to force it even with credentials present.
 *
 * Unregistered recipients (FCM row, no token at dispatch time) become SKIPPED
 * with error_code='UNREGISTERED' — an honest ledger instead of silent loss.
 */

import crypto from 'node:crypto';
import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';

export type DispatchOutcome =
  | { ok: true; provider_msg_id: string; dry_run?: boolean }
  | { ok: false; error_code: string };

/* ---------------------------------------------------------------------------
 * FCM HTTP v1
 * ------------------------------------------------------------------------- */

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

let cachedSa: ServiceAccount | null | undefined;
function readServiceAccount(): ServiceAccount | null {
  if (cachedSa !== undefined) return cachedSa;
  cachedSa = null;
  const raw = env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw || !env.FCM_PROJECT) return cachedSa;
  try {
    // Accept raw JSON or single-line base64 (env files hate embedded newlines).
    let text = raw;
    if (!text.trim().startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8');
    const j = JSON.parse(text);
    if (j.client_email && j.private_key) {
      // \n escapes survive base64 but not naive dotenv quoting — normalize.
      cachedSa = { client_email: j.client_email, private_key: j.private_key.replace(/\\n/g, '\n'),
                   token_uri: j.token_uri };
    }
  } catch { cachedSa = null; }
  return cachedSa;
}

let fcmDryRun: boolean | null = null;
export function isFcmDryRun(): boolean {
  if (fcmDryRun !== null) return fcmDryRun;
  fcmDryRun = process.env.NOTIFY_DISPATCH_DRY_RUN === 'true' || !(readServiceAccount() && env.FCM_PROJECT);
  return fcmDryRun;
}

// OAuth2 access-token cache (expires ~1h; refresh 5 min early).
let oauth: { token: string; expMs: number } | null = null;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Signed-JWT grant (RFC 7523) — same shape google-auth-library produces. */
async function getFcmAccessToken(): Promise<string | null> {
  const sa = readServiceAccount();
  if (!sa) return null;
  if (oauth && Date.now() < oauth.expMs - 300_000) return oauth.token;
  const nowS = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis/auth/firebase.messaging',
    aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: nowS, exp: nowS + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const assertion = `${unsigned}.${signature}`;
  try {
    const res = await fetch(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) return null;
    const j = await res.json() as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    oauth = { token: j.access_token, expMs: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return oauth.token;
  } catch { return null; }
}

async function userPushTokens(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ token: string }>(
    `SELECT token FROM user_push_tokens WHERE user_id = $1`, [userId]);
  return rows.map((r) => r.token);
}

/** Rendered title/body were stored in detail at queue time (redacted-safe). */
function messageOf(detail: Record<string, any>): { title: string; body: string } {
  return { title: String(detail.title ?? 'YET'), body: String(detail.body ?? '') };
}

export async function sendFcm(notificationRow: {
  notification_id: string; recipient_id: string; detail: Record<string, any>;
}): Promise<DispatchOutcome> {
  const { title, body } = messageOf(notificationRow.detail);
  const tokens = await userPushTokens(notificationRow.recipient_id);
  if (tokens.length === 0) return { ok: false, error_code: 'UNREGISTERED' };
  if (isFcmDryRun()) {
    return { ok: true, provider_msg_id: `dry-run:${tokens[0]!.slice(0, 12)}`, dry_run: true };
  }
  const accessToken = await getFcmAccessToken();
  if (!accessToken) return { ok: false, error_code: 'AUTH_FAILED' };
  const url = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT}/messages:send`;
  try {
    const results = await Promise.all(tokens.map(async (token) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: {
          token,
          notification: { title, body },
          android: { priority: 'HIGH', notification: { channel_id: 'yet_trips', default_sound: true } },
        } }),
      });
      if (!res.ok) return { ok: false, code: `HTTP_${res.status}` };
      const j = await res.json() as { name?: string };
      return { ok: true, id: j.name ?? 'sent' };
    }));
    const firstOk = results.find((r) => r.ok);
    if (firstOk) return { ok: true, provider_msg_id: (firstOk as any).id };
    return { ok: false, error_code: String((results[0] as any)?.code ?? 'SEND_FAILED') };
  } catch (err: any) {
    return { ok: false, error_code: err?.name ?? 'NETWORK' };
  }
}

/* ---------------------------------------------------------------------------
 * SMS fallback (local Ethiopian gateway)
 * ------------------------------------------------------------------------- */

export async function sendSms(notificationRow: {
  recipient_id: string; detail: Record<string, any>;
}): Promise<DispatchOutcome> {
  const { rows } = await pool.query<{ phone_e164: string | null }>(
    `SELECT phone_e164 FROM users WHERE id = $1`, [notificationRow.recipient_id]);
  const phone = rows[0]?.phone_e164;
  if (!phone) return { ok: false, error_code: 'NO_PHONE' };
  if (!env.SMS_GATEWAY_URL) return { ok: false, error_code: 'GATEWAY_UNSET' };
  if (process.env.NOTIFY_DISPATCH_DRY_RUN === 'true') {
    return { ok: true, provider_msg_id: 'dry-run:sms', dry_run: true };
  }
  const { title, body } = messageOf(notificationRow.detail);
  try {
    const res = await fetch(env.SMS_GATEWAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: phone, from: env.SMS_GATEWAY_SENDER, message: `${title}: ${body}` }),
    });
    if (!res.ok) return { ok: false, error_code: `HTTP_${res.status}` };
    const j = await res.json().catch(() => ({})) as { id?: string; reference?: string };
    return { ok: true, provider_msg_id: j.id ?? j.reference ?? 'sms-sent' };
  } catch (err: any) {
    return { ok: false, error_code: err?.name ?? 'NETWORK' };
  }
}

/* ---------------------------------------------------------------------------
 * Pickup worker loop
 * ------------------------------------------------------------------------- */

const DISPATCH_BATCH = 20;

/** One pass: claim up to N QUEUED rows (SKIP LOCKED ⇒ safe under multiple
 *  workers/restarts), dispatch by channel, write terminal status. Returns counts. */
export async function dispatchQueuedOnce(limit = DISPATCH_BATCH): Promise<{ sent: number; failed: number; skipped: number }> {
  const { rows } = await pool.query(
    `SELECT notification_id, recipient_id, channel::text AS channel, detail
       FROM notification_log
      WHERE status = 'QUEUED'
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`, [limit]);
  let sent = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    const outcome = row.channel === 'SMS'
      ? await sendSms(row as any)
      : await sendFcm(row as any);
    if (outcome.ok) {
      await pool.query(
        `UPDATE notification_log SET status='SENT', sent_at=now(), provider_msg_id=$2
          WHERE notification_id=$1 AND status='QUEUED'`,
        [row.notification_id, outcome.dry_run ? outcome.provider_msg_id : outcome.provider_msg_id]);
      sent++;
    } else if (outcome.error_code === 'UNREGISTERED') {
      await pool.query(
        `UPDATE notification_log SET status='SKIPPED', error_code=$2, sent_at=NULL
          WHERE notification_id=$1 AND status='QUEUED'`,
        [row.notification_id, outcome.error_code]);
      skipped++;
    } else {
      await pool.query(
        `UPDATE notification_log SET status='FAILED', sent_at=now(), error_code=$2
          WHERE notification_id=$1 AND status='QUEUED'`,
        [row.notification_id, outcome.error_code]);
      failed++;
    }
  }
  return { sent, failed, skipped };
}

let timer: NodeJS.Timeout | null = null;

/** Start the in-process dispatcher loop (composition root calls this). */
export function startDispatcherLoop(intervalMs = 5_000): void {
  if (timer) return;
  timer = setInterval(() => {
    dispatchQueuedOnce().catch((err) => console.warn('[notify-dispatch] pass failed:', err?.message ?? err));
  }, intervalMs);
  timer.unref?.();
}

export function stopDispatcherLoop(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
