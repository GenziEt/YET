import pg from 'pg';
import { env } from '../config/env.js';
/**
 * Shared Postgres pool. Modules NEVER open their own pools — one pool per process
 * keeps the monolith honest when a module is extracted into its own service later
 * (the module just gets its own deployment pointing at the same schema conventions).
 */
export const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});
export async function checkDb() {
    try {
        await pool.query('SELECT 1');
        return true;
    }
    catch {
        return false;
    }
}
/** Parameterized multi-row insert helper used by Ingest (§1.10.1 batch writes). */
export async function insertMany(sqlPrefix, // e.g. "INSERT INTO location_fixes (a,b) VALUES "
rows, onConflict) {
    if (rows.length === 0)
        return { rowCount: 0 };
    const params = [];
    const tuples = rows.map((row, ri) => {
        row.forEach((v, ci) => params.push(v));
        return `(${row.map((_, ci) => `$${ri * row.length + ci + 1}`).join(',')})`;
    });
    const text = `${sqlPrefix}${tuples.join(',')}${onConflict ? ' ' + onConflict : ''}`;
    const res = await pool.query(text, params);
    return { rowCount: res.rowCount ?? 0 };
}
//# sourceMappingURL=pool.js.map