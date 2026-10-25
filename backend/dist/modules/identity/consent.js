import { pool } from '../../db/pool.js';
/** Ordered history — append-only. The last element is the live policy. */
export const CONSENT_POLICY_VERSIONS = [
    {
        id: 'consent-v1',
        releasedAt: '2026-01-15',
        requiredScopes: ['location', 'motion'], // §1.7 minimization: mandatory set
        optionalScopes: ['audio'], // engine-audio confirmation is opt-in
    },
];
export const CURRENT_CONSENT_POLICY = CONSENT_POLICY_VERSIONS[CONSENT_POLICY_VERSIONS.length - 1];
export function isValidPolicyVersion(id) {
    return CONSENT_POLICY_VERSIONS.some((v) => v.id === id);
}
/** All scope names ever defined across versions — used to validate payloads. */
export const ALL_CONSENT_SCOPES = Array.from(new Set(CONSENT_POLICY_VERSIONS.flatMap((v) => [...v.requiredScopes, ...v.optionalScopes])));
/** A grant is valid only if it was issued FOR THE CURRENT policy version, is not
 *  revoked, and covers every scope the current policy requires. */
export function isGrantValid(grant) {
    if (!grant)
        return false;
    if (grant.revoked_at)
        return false;
    if (grant.policy_version !== CURRENT_CONSENT_POLICY.id)
        return false;
    return CURRENT_CONSENT_POLICY.requiredScopes.every((s) => grant.granted_scopes.includes(s));
}
/** Latest grant for a driver, evaluated against the live policy version. */
export async function getEffectiveConsent(driverId) {
    const res = await pool.query(`SELECT policy_version, locale, granted_scopes,
            granted_at::text AS granted_at, revoked_at::text AS revoked_at
       FROM consent_records
      WHERE driver_id = $1
      ORDER BY granted_at DESC
      LIMIT 1`, [driverId]);
    const record = res.rows[0] ?? null;
    return { hasCurrent: isGrantValid(record), record };
}
/**
 * Collection guard — throws HTTP 403 with a machine-readable reason when ingest
 * would be unlawful. Callers (ingest routes) map this to a 403 response; the
 * driver app reacts by returning to the consent screen.
 */
export async function assertConsentActive(driverId) {
    const { hasCurrent } = await getEffectiveConsent(driverId);
    if (!hasCurrent) {
        throw Object.assign(new Error('consent_required'), { statusCode: 403 });
    }
}
/**
 * Idempotent maintenance pass invoked after any POST /consent: once somebody
 * accepts the current policy, grants for superseded versions are stamped
 * revoked (they were already treated as invalid; this makes the fact durable
 * and queryable). Safe to run repeatedly.
 */
export async function revokeSupersededConsents() {
    const { rowCount } = await pool.query(`UPDATE consent_records SET revoked_at = now()
      WHERE policy_version <> $1 AND revoked_at IS NULL`, [CURRENT_CONSENT_POLICY.id]);
    return rowCount ?? 0;
}
//# sourceMappingURL=consent.js.map