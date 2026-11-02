import { pool } from '../db/pool.js';
import { verifyAccessToken } from './jwt.js';
/**
 * JWT pre-expiry revocation (production-readiness audit, P1: "JWT has no
 * revocation path — 12 h tokens remain valid after device un-pairing / account
 * suspension until expiry"). Migration 0017 adds users.token_version; every
 * token mint stamps it as the `tv` claim. Revocation events (device un-pairing,
 * driver suspension, admin device revoke) bump the column — instantly
 * invalidating all outstanding tokens for that user without waiting for the
 * TTL to lapse.
 *
 * Enforcement is centralized in registerRevocationHook() below: every module
 * guard parses the Bearer header inside its own file; rather than touching all
 * eight guards (and risking a future route forgetting one), this onRequest hook
 * checks the token version once per request, before routing. Public routes are
 * skipped by exact path; anything else carrying a Bearer header is checked.
 * A malformed/expired Bearer fails OPEN here and defers to the route's own
 * guard — the hook only ADDS revocation enforcement, never weakens auth.
 *
 * Cost: one indexed PK read (`SELECT token_version FROM users WHERE id=$1`)
 * per authenticated request. The DB is already mandatory for these routes.
 *
 * Fail-closed contract: if the DB read errors, authenticated requests are
 * denied — same posture as lib/tenant.ts and the onboarding authGuard. A
 * cache-style "degrade to allow" would silently defeat the mechanism.
 */
const PUBLIC_EXACT = new Set([
    '/healthz', '/readyz', '/openapi.yaml',
    '/auth/login', '/me/bootstrap', // staff password entry points
    '/auth/register/otp/request', '/auth/register/complete',
    '/auth/otp/request', '/auth/pair-device', // driver OTP entry points
]);
export async function registerRevocationHook(app) {
    app.addHook('onRequest', async (req, reply) => {
        const url = (req.url ?? '').split('?')[0];
        if (PUBLIC_EXACT.has(url))
            return;
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer '))
            return; // unauthenticated: route guards deny as before
        let claims;
        try {
            claims = verifyAccessToken(header.slice(7));
        }
        catch {
            return; // bad token shape/expiry -> the route's own guard produces its canonical 401
        }
        try {
            await assertTokenLive(claims);
        }
        catch (e) {
            if (e instanceof RevokedError) {
                return reply.code(401).send({ error: 'token_revoked' });
            }
            // DB unreadable -> fail CLOSED for authenticated traffic (same posture as
            // lib/tenant.ts): we cannot prove the token is live, so we deny.
            return reply.code(503).send({ error: 'auth_backend_unavailable' });
        }
    });
}
/** Fail-closed denial for a revoked token (message doubles as the machine-
 *  readable code surfaced by the hook and route guards). */
export class RevokedError extends Error {
    statusCode = 401;
    constructor() { super('token_revoked'); }
}
/** Throws RevokedError when the token's stamped version no longer matches the
 *  live users row (or the row vanished / read failed). Legacy tokens minted
 *  before migration 0017 carry no `tv`; they are treated as version 0 — which
 *  keeps them working until their natural expiry AND until any revocation bump
 *  (a bumped user's legacy token then dies too, because tv mismatch ≠ absent). */
export async function assertTokenLive(claims) {
    const { rows } = await pool.query(`SELECT token_version FROM users WHERE id = $1 LIMIT 1`, [claims.sub]);
    const live = rows[0]?.token_version ?? null;
    if (live === null)
        throw new RevokedError(); // user gone (erased/deleted) → deny
    const presented = claims.tokenVersion ?? 0; // legacy claim == epoch 0
    if (presented !== live)
        throw new RevokedError();
}
/** Bump a user's revocation epoch. Call inside the SAME handler that performs
 *  the revocation side-effect (device revoke / suspend), before replying.
 *  Returns nothing; a DB error propagates (fail-closed: an un-bumped revocation
 *  must not be reported as success). */
export async function bumpTokenVersion(userId) {
    await pool.query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [userId]);
}
//# sourceMappingURL=revocation.js.map