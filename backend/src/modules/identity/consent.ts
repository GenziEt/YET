import { pool } from '../../db/pool.js';

/**
 * Module 1 — Consent policy registry & guard (PDPP §1.7, Phase 0 deliverable).
 *
 * Single source of truth for the consent-policy lifecycle. Everything that
 * depends on consent state reads it through this file:
 *   - POST /consent           validates the accepted version against the registry
 *   - GET /consent/current    reports `required` using the registry
 *   - ingest collection guard calls assertConsentActive() BEFORE accepting any
 *     location/sensor/battery/diagnostic batch (Phase 0 item: "collection guards
 *     check consent state before allowing ingest").
 *
 * VERSIONING CONTRACT: CONSENT_POLICY_VERSIONS is an ordered list; the LAST
 * entry is the currently-required version. Bumping the policy means appending a
 * new id here (and translating the new text in the driver app + docs). Because
 * consent_records stores the version a driver actually granted, every older
 * grant becomes invalid automatically:
 *   - getEffectiveConsent() returns hasCurrent=false, so the app re-prompts; and
 *   - revokeSupersededConsents() stamps revoked_at on all non-current rows so
 *     the database itself reflects the invalidation ("a policy change
 *     invalidates prior consent and forces re-consent"), which keeps audit and
 *     erasure queries honest.
 */

export interface ConsentPolicyVersion {
  id: string;            // e.g. "consent-v1" — stored verbatim in consent_records
  releasedAt: string;    // ISO date of publication
  /** Scopes a driver MUST grant for ingest to be lawful at this version. */
  requiredScopes: readonly string[];
  /** Optional scopes drivers may decline without losing service. */
  optionalScopes: readonly string[];
}

/** Ordered history — append-only. The last element is the live policy. */
export const CONSENT_POLICY_VERSIONS: readonly ConsentPolicyVersion[] = [
  {
    id: 'consent-v1',
    releasedAt: '2026-01-15',
    requiredScopes: ['location', 'motion'], // §1.7 minimization: mandatory set
    optionalScopes: ['audio'],              // engine-audio confirmation is opt-in
  },
];

export const CURRENT_CONSENT_POLICY = CONSENT_POLICY_VERSIONS[CONSENT_POLICY_VERSIONS.length - 1]!;

export function isValidPolicyVersion(id: string): boolean {
  return CONSENT_POLICY_VERSIONS.some((v) => v.id === id);
}

/** All scope names ever defined across versions — used to validate payloads. */
export const ALL_CONSENT_SCOPES: readonly string[] = Array.from(
  new Set(CONSENT_POLICY_VERSIONS.flatMap((v) => [...v.requiredScopes, ...v.optionalScopes])),
);

/** A grant is valid only if it was issued FOR THE CURRENT policy version, is not
 *  revoked, and covers every scope the current policy requires. */
export function isGrantValid(
  grant: { policy_version: string; revoked_at: Date | string | null; granted_scopes: string[] } | null | undefined,
): boolean {
  if (!grant) return false;
  if (grant.revoked_at) return false;
  if (grant.policy_version !== CURRENT_CONSENT_POLICY.id) return false;
  return CURRENT_CONSENT_POLICY.requiredScopes.every((s) => grant.granted_scopes.includes(s));
}

export interface EffectiveConsent {
  hasCurrent: boolean;
  record: {
    policy_version: string;
    locale: string;
    granted_scopes: string[];
    granted_at: string;
    revoked_at: string | null;
  } | null;
}

/** Latest grant for a driver, evaluated against the live policy version. */
export async function getEffectiveConsent(driverId: string): Promise<EffectiveConsent> {
  const { rows } = await pool.query<EffectiveConsent['record']>(
    `SELECT policy_version, locale, granted_scopes,
            granted_at::text AS granted_at, revoked_at::text AS revoked_at
       FROM consent_records
      WHERE driver_id = $1
      ORDER BY granted_at DESC
      LIMIT 1`,
    [driverId],
  );
  const record = rows[0] ?? null;
  return { hasCurrent: isGrantValid(record), record };
}

/**
 * Collection guard — throws HTTP 403 with a machine-readable reason when ingest
 * would be unlawful. Callers (ingest routes) map this to a 403 response; the
 * driver app reacts by returning to the consent screen.
 */
export async function assertConsentActive(driverId: string): Promise<void> {
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
export async function revokeSupersededConsents(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE consent_records SET revoked_at = now()
      WHERE policy_version <> $1 AND revoked_at IS NULL`,
    [CURRENT_CONSENT_POLICY.id],
  );
  return rowCount ?? 0;
}
