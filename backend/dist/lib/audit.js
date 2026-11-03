import net from 'node:net';
import { pool } from '../db/pool.js';
/** True for a valid IPv4/IPv6 string (what a Postgres INET column accepts). */
function isIpAddress(value) {
    return net.isIP(value) !== 0;
}
/**
 * PDPP §1.7 breach-readiness helper. EVERY read/write of personal data must call this.
 * Keeps the 72h ECA notification window feasible: query audit_log by target_user.
 */
export async function audit(params) {
    // Hardening: audit_log.ip is an INET column. req.ip can carry proxy-supplied
    // or malformed values; a bad insert would fail every audited read path.
    // Validate leniently — anything non-parseable is recorded as NULL rather
    // than rejected at the DB layer.
    const ip = typeof params.ip === 'string' && params.ip.trim() !== ''
        ? (isIpAddress(params.ip.trim()) ? params.ip.trim() : null)
        : null;
    try {
        await pool.query(`INSERT INTO audit_log (actor_id, action, target_user, ip, detail)
       VALUES ($1,$2,$3,$4,$5)`, [params.actorId ?? null, params.action, params.targetUser ?? null,
            ip, params.detail ? JSON.stringify(params.detail) : null]);
    }
    catch (err) {
        // Audit must never break the request path, but a silent audit failure is a
        // compliance incident — log loudly for alerting.
        console.error('AUDIT WRITE FAILED', err);
    }
}
//# sourceMappingURL=audit.js.map