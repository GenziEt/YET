import crypto from 'node:crypto';

/**
 * In-memory secret material generated once per process at boot.
 *
 * Why this exists (production-readiness audit, OTP hardening): OTP codes are
 * stored HASHED in Redis. A plain unsalted SHA-256 of phone.code.separator is
 * brute-forceable offline (~10^6 candidates) if a Redis snapshot (RDB/AOF) or
 * a backup ever persists — the phone number is known to the attacker (it is
 * their own account). The fix is HMAC keyed with a server secret: an attacker
 * holding the Redis dump still cannot verify guesses without the key.
 *
 * Why NOT an env var for this particular secret: adding a REQUIRED env knob
 * would break every existing deployment on upgrade (fail-closed boot rejects
 * the missing variable). Instead we derive ephemeral per-process key material:
 *   - Codes live 5 minutes and are one-shot (consumed on verify), so the key
 *     only needs to survive a single request-cycle within ONE process.
 *   - A multi-process deployment behind a round-robin balancer could mint an
 *     OTP in worker A and verify it in worker B — with a random per-process
 *     key that verification fails CLOSED (user simply re-requests a code).
 *     Never a security hole, only a rare extra SMS.
 * Ops who want deterministic cross-worker hashing can set OTP_HASH_SECRET
 * (recommended once the API scales past one worker); when unset we fall back
 * to a random 32-byte secret logged nowhere.
 */
let cached: Buffer | null = null;

export function otpHashKey(): Buffer {
  if (!cached) {
    const fromEnv = process.env.OTP_HASH_SECRET ?? '';
    cached = fromEnv.length >= 16
      ? crypto.createHash('sha256').update(fromEnv).digest()
      : crypto.randomBytes(32);
  }
  return cached;
}

/** Test seam: reset memoized key (used by unit tests that flip the env var). */
export function resetOtpHashKeyForTests(): void { cached = null; }
