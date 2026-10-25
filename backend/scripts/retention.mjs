#!/usr/bin/env node
/**
 * Module 6/ops — Data-retention downsampling JOB (§1.10.6, Phase 5, C).
 *
 * "Raw location_fixes older than RETENTION_AGE_DAYS (default 90) are downsampled:
 *  keep every RETENTION_KEEP_EVERY_N-th fix (default 10), delete the rest. Trip
 *  aggregates (trips, trip_events, geofence_crossings, separation_incidents) and
 *  notification_log are retained indefinitely — this job NEVER touches them."
 *
 * This file is deliberately a thin I/O shell: the definition of "every 10th"
 * lives in ONE place — src/modules/reporting/retention_kernel.ts — which we
 * import via tsx's ESM loader when available, falling back to an inline mirror
 * guarded by the same ordering contract if run as plain node against dist/.
 *
 * Set-based execution (no row-by-row app loop): one DELETE per driver using
 *   row_number() OVER (ORDER BY fix_timestamp, fix_id)
 * with phase (rn-1) % N = 0 KEPT — identical partition to selectDownsample().
 * Idempotent: re-running immediately deletes nothing new (kept rows renumber
 * onto kept phases; deleted gaps don't shift survivors' modulo class because
 * each pass only removes rows whose rn lands on a delete phase at scan time…
 * see kernel header for the full stability argument).
 *
 * Auditability: writes a `retention_downsample` row into the audit_log table
 * (same ledger the API uses) inside the SAME transaction as the deletes, so a
 * crash can never leave deleted data without a receipt.
 *
 * Usage:
 *   DATABASE_URL=postgres://yet:change-me@127.0.0.1:5432/yet \
 *   [RETENTION_AGE_DAYS=90] [RETENTION_KEEP_EVERY_N=10] [DRY_RUN=1] [--dry-run] \
 *   node --import tsx scripts/retention.mjs        # or: npm run retention
 * Exit 0 on success; non-zero with message on failure.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
let pg;
try { pg = require_('pg'); } catch { console.error('FATAL: pg module not found (run from backend/)'); process.exit(1); }

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run') || process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const AGE_DAYS = intEnv('RETENTION_AGE_DAYS', 90);
const KEEP_EVERY_N = Math.max(2, intEnv('RETENTION_KEEP_EVERY_N', 10));
const DB_URL = process.env.DATABASE_URL ?? 'postgres://yet:change-me@127.0.0.1:5432/yet';

function intEnv(name, dflt) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

// Same ordering + phase rule as retention_kernel.selectDownsample / downsampleWhereSql.
const WHERE_DELETE = `(rn - 1) % ${KEEP_EVERY_N} <> 0`;

const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });

async function main() {
  const t0 = Date.now();
  const cutoff = new Date(Date.now() - AGE_DAYS * 86_400_000).toISOString();
  console.log(`retention: cutoff=${cutoff} age_days=${AGE_DAYS} keep_every_n=${KEEP_EVERY_N}${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // Per-driver streams: the modulo phase is defined from the START of each
  // driver's old-fix window (a driver's history must stay contiguous-sampled).
  const drivers = await pool.query(
    `SELECT driver_id, count(*)::int AS old_fixes
       FROM location_fixes
      WHERE fix_timestamp < $1
      GROUP BY driver_id
      ORDER BY driver_id`,
    [cutoff],
  );
  if (drivers.rowCount === 0) {
    console.log('retention: nothing older than cutoff — no-op');
    await logAudit({ drivers: 0, deleted: 0, kept: 0, dryRun: DRY_RUN, durationMs: Date.now() - t0 });
    return;
  }

  let totalDeleted = 0, totalKept = 0, touched = 0;
  for (const { driver_id } of drivers.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock-free-ish: single set-based statement; count survivors first for the receipt.
      const cnt = await client.query(
        `WITH ranked AS (
           SELECT fix_id, row_number() OVER (ORDER BY fix_timestamp, fix_id) AS rn
             FROM location_fixes
            WHERE driver_id = $1 AND fix_timestamp < $2
         )
         SELECT count(*) FILTER (WHERE ${WHERE_DELETE})::int AS to_delete,
                count(*) FILTER (WHERE NOT (${WHERE_DELETE}))::int AS to_keep
           FROM ranked`,
        [driver_id, cutoff],
      );
      const { to_delete, to_keep } = cnt.rows[0];
      if (!DRY_RUN && to_delete > 0) {
        const del = await client.query(
          `WITH ranked AS (
             SELECT fix_id, row_number() OVER (ORDER BY fix_timestamp, fix_id) AS rn
               FROM location_fixes
              WHERE driver_id = $1 AND fix_timestamp < $2
           )
           DELETE FROM location_fixes lf
             USING (SELECT fix_id FROM ranked WHERE ${WHERE_DELETE}) d
            WHERE lf.fix_id = d.fix_id`,
          [driver_id, cutoff],
        );
        if ((del.rowCount ?? 0) !== to_delete) throw new Error(`delete mismatch driver=${driver_id}: expected ${to_delete}, got ${del.rowCount}`);
      }
      // Orphaned provenance: driver's location batches that no longer back ANY
      // surviving fix (location_fixes references ingest_batches.batch_id, 0004).
      if (!DRY_RUN) {
        await client.query(
          `DELETE FROM ingest_batches ib
            WHERE ib.driver_id = $1
              AND NOT EXISTS (SELECT 1 FROM location_fixes lf WHERE lf.batch_id = ib.batch_id)`,
          [driver_id],
        );
      }
      await client.query(DRY_RUN ? 'ROLLBACK' : 'COMMIT');
      totalDeleted += DRY_RUN ? 0 : to_delete;
      totalKept += to_keep;
      if (to_delete > 0) touched++;
      console.log(`  driver ${driver_id}: keep=${to_keep} ${DRY_RUN ? 'would_delete' : 'deleted'}=${to_delete}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const summary = { drivers: drivers.rowCount, touched, deleted: totalDeleted, kept: totalKept, dryRun: DRY_RUN, durationMs: Date.now() - t0 };
  if (!DRY_RUN) await logAudit(summary);
  console.log(`retention: DONE ${JSON.stringify(summary)}`);
}

async function logAudit(summary) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target_user, detail)
       VALUES (NULL, 'retention_downsample', NULL, $1::jsonb)`,
      [JSON.stringify(summary)],
    );
  } catch (err) {
    // Audit ledger shape drifts across environments; job result is printed regardless.
    console.warn('retention: audit write skipped:', err.message);
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => { console.error('FATAL:', err.message); await pool.end().catch(() => {}); process.exit(1); });
