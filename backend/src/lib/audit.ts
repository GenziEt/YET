import crypto from 'node:crypto';
import net from 'node:net';
import { pool } from '../db/pool.js';
import { otpHashKey } from './secrets.js';

/**
 * One-way pseudonym for phone numbers in audit details (PDPP minimization).
 * Deterministic HMAC keyed with the server's OTP hash key so analysts can
 * correlate rows across events without ever seeing the number itself.
 */
function phonePseudonym(phone: string): string {
  return crypto.createHmac('sha256', otpHashKey())
    .update(`audit-phone:${phone}`)
    .digest('hex')
    .slice(0, 32);
}

/** True for a valid IPv4/IPv6 string (what a Postgres INET column accepts). */
function isIpAddress(value: string): boolean {
  return net.isIP(value) !== 0;
}

/**
 * PDPP §1.7 breach-readiness helper. EVERY read/write of personal data must call this.
 * Keeps the 72h ECA notification window feasible: query audit_log by target_user.
 */
export async function audit(params: {
  actorId?: string | null;
  action: string;
  targetUser?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  // Data minimization (security audit P3): raw phone numbers never enter the
  // audit trail. Any `phone` field in a detail payload is replaced with a
  // one-way HMAC pseudonym (`phone_hmac`) — still correlatable across rows
  // for incident/breach analysis, useless to leak readers. The authoritative
  // number stays only in users.phone_e164 / otp_requests (operationally
  // required, covered by the §4 erasure path). See docs/COMPLIANCE-PDPP.md §2.
  let detail = params.detail;
  if (detail && typeof detail.phone === 'string') {
    const { phone, ...rest } = detail;
    detail = { ...rest, phone_hmac: phonePseudonym(phone) };
  }
  // Hardening: audit_log.ip is an INET column. req.ip can carry proxy-supplied
  // or malformed values; a bad insert would fail every audited read path.
  // Validate leniently — anything non-parseable is recorded as NULL rather
  // than rejected at the DB layer.
  const ip = typeof params.ip === 'string' && params.ip.trim() !== ''
    ? (isIpAddress(params.ip.trim()) ? params.ip.trim() : null)
    : null;
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target_user, ip, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [params.actorId ?? null, params.action, params.targetUser ?? null,
       ip, detail ? JSON.stringify(detail) : null],
    );
  } catch (err) {
    // Audit must never break the request path, but a silent audit failure is a
    // compliance incident — log loudly for alerting.
    console.error('AUDIT WRITE FAILED', err);
  }
}
