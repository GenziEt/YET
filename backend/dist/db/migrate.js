#!/usr/bin/env tsx
/**
 * Minimal forward-only SQL migration runner.
 *  - Applies src/db/migrations/*.sql in lexicographic order.
 *  - Tracks applied files in schema_migrations.
 *  - Each migration runs inside a transaction; re-running is a no-op (idempotent).
 * Migrations must therefore be written idempotently where possible
 * (CREATE TABLE IF NOT EXISTS etc.) to survive partial-failure retries.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
async function main() {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await pool.query('SELECT filename FROM schema_migrations');
    const done = new Set(rows.map((r) => r.filename));
    for (const f of files) {
        if (done.has(f)) {
            console.log(`skip   ${f}`);
            continue;
        }
        const sql = readFileSync(path.join(dir, f), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [f]);
            await client.query('COMMIT');
            console.log(`apply  ${f}`);
        }
        catch (err) {
            await client.query('ROLLBACK');
            console.error(`FAILED ${f}:`, err);
            process.exitCode = 1;
            break;
        }
        finally {
            client.release();
        }
    }
    await pool.end();
}
main();
//# sourceMappingURL=migrate.js.map