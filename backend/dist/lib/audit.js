import { pool } from '../db/pool.js';
/**
 * PDPP §1.7 breach-readiness helper. EVERY read/write of personal data must call this.
 * Keeps the 72h ECA notification window feasible: query audit_log by target_user.
 */
export async function audit(params) {
    try {
        await pool.query(`INSERT INTO audit_log (actor_id, action, target_user, ip, detail)
       VALUES ($1,$2,$3,$4,$5)`, [params.actorId ?? null, params.action, params.targetUser ?? null,
            params.ip ?? null, params.detail ? JSON.stringify(params.detail) : null]);
    }
    catch (err) {
        // Audit must never break the request path, but a silent audit failure is a
        // compliance incident — log loudly for alerting.
        console.error('AUDIT WRITE FAILED', err);
    }
}
//# sourceMappingURL=audit.js.map