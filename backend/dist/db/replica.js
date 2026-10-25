import pg from 'pg';
import { env } from '../config/env.js';
import { pool } from './pool.js';
/**
 * Postgres READ REPLICA pool (§1.10.3, Phase 5).
 *
 * Scaling guardrail: "Reporting module reads from a Postgres read replica, never
 * the primary. Ingest and Trip Engine write to primary only." This module makes
 * that rule structural instead of conventional:
 *
 *  - Reporting (Module 6) and fleet-overview reads call `readPool()`.
 *  - When READER_DATABASE_URL is unset (dev, single-DB pilots), `readPool()`
 *    returns the PRIMARY pool — same behavior as before Phase 5, zero config.
 *  - When set, it points at a physical/logical replica in the SAME Ethiopian
 *    data center (PDPP §1.7 data sovereignty applies to replicas too — an
 *    off-shore replica is a Proclamation violation, not an optimization).
 *  - A `readOnly` transaction is enforced on every replica query so an
 *    accidental write fails loudly instead of silently splitting state.
 *
 * Replica lag is surfaced via `replicaLagSeconds()` for the dashboard staleness
 * banner (§1.8.4): reports may lag the live map by seconds; we say so honestly.
 */
let replica = null;
export function hasDedicatedReplica() {
    return Boolean(env.READER_DATABASE_URL);
}
/** The pool readers must use. Falls back to primary when no replica configured. */
export function readPool() {
    if (!env.READER_DATABASE_URL)
        return pool; // dev fallback — still read-only by convention
    if (!replica) {
        replica = new pg.Pool({
            connectionString: env.READER_DATABASE_URL,
            max: 10, // reporting queries are heavier; keep replica headroom predictable
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
        });
        replica.on('error', (err) => console.error('[replica] pool error:', err.message));
    }
    return replica;
}
/**
 * Run a read-only query against the replica (or primary fallback). Wraps in a
 * READ ONLY transaction when talking to a real replica so writes are impossible
 * even if a future refactor passes an INSERT here.
 */
export async function readQuery(text, params) {
    const target = readPool();
    if (target === pool && !hasDedicatedReplica()) {
        const res = await pool.query(text, params);
        return res.rows;
    }
    const client = await target.connect();
    try {
        await client.query('BEGIN READ ONLY');
        const res = await client.query(text, params);
        await client.query('COMMIT');
        return res.rows;
    }
    catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    }
    finally {
        client.release();
    }
}
/**
 * Replica lag vs primary in seconds (pg_last_wal_receive_lsn is NULL on a plain
 * non-replica DB → returns 0 meaning "no measurable lag"). Used by
 * GET /reports/fleet-state to annotate staleness (§1.8.4 honesty rule).
 */
export async function replicaLagSeconds() {
    if (!hasDedicatedReplica())
        return 0;
    try {
        const rows = await readQuery(`SELECT EXTRACT(EPOCH FROM (now() - COALESCE(
              pg_last_xact_replay_timestamp(), now()))) AS lag_s`);
        return Math.max(0, Math.round(Number(rows[0]?.lag_s ?? 0)));
    }
    catch {
        return -1; // lag unknown — caller should treat cache freshness conservatively
    }
}
export async function closeReplica() {
    if (replica) {
        await replica.end().catch(() => { });
        replica = null;
    }
}
//# sourceMappingURL=replica.js.map