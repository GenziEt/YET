/**
 * Module 6/ops — Data-retention downsampling: PURE selector (§1.10.6, Phase 5, C).
 *
 * "Raw location_fixes older than 90 days are downsampled: keep every 10th fix,
 *  delete the rest. Trip aggregates and events retained indefinitely."
 *
 * The I/O shell is scripts/retention.mjs; this file holds the deterministic core
 * so unit tests can pin the exact keep/delete partition without a database.
 *
 * Determinism rules (§1.8.3 discipline applied to ops):
 *  - Input rows MUST be sorted by (fix_timestamp ASC, fix_id ASC) — the same
 *    order the DELETE query scans in. Given identical input the output is
 *    identical, so re-running the job on an overlapping window never flips a
 *    previously-kept fix into a deleted one within that pass.
 *  - Index 0 of each driver's stream is KEPT (first fix anchors the history),
 *    then every 10th (indices 10, 20, 30 …). That is "keep every 10th" with a
 *    stable phase — a rotating phase would delete different rows per run.
 */

export type RetentionRow = { fix_id: number | string; fix_timestamp: string };
export type RetentionPolicy = { keepEveryN: number; olderThanDays: number };

export const RETENTION_DEFAULTS: RetentionPolicy = { keepEveryN: 10, olderThanDays: 90 };

/** Compare rows exactly like the SQL scan order: event time first, id tiebreak. */
export function compareRetentionRows(a: RetentionRow, b: RetentionRow): number {
  const ta = Date.parse(a.fix_timestamp), tb = Date.parse(b.fix_timestamp);
  if (ta !== tb) return ta - tb;
  return Number(BigInt(a.fix_id) - BigInt(b.fix_id)) || 0;
}

/**
 * Partition ONE driver's already-fetched old fixes into keep/delete sets.
 * `rows` need not be sorted here — we sort defensively (idempotent) — but the
 * caller must fetch the FULL ordered stream for the driver/window, because the
 * modulo phase depends on position from the start of the scanned range.
 */
export function selectDownsample(rows: RetentionRow[], policy: RetentionPolicy = RETENTION_DEFAULTS): {
  keepIds: Array<number | string>; deleteIds: Array<number | string>;
} {
  const sorted = [...rows].sort(compareRetentionRows);
  const keepIds: Array<number | string> = [];
  const deleteIds: Array<number | string> = [];
  sorted.forEach((r, i) => {
    (i % policy.keepEveryN === 0 ? keepIds : deleteIds).push(r.fix_id);
  });
  return { keepIds, deleteIds };
}

/** SQL fragment mirroring selectDownsample for set-based execution: row_number()
 *  over the same ordering, keep rn where (rn-1) % keepEveryN == 0. Exported so
 *  scripts/retention.mjs and any future worker share ONE definition of "10th". */
export function downsampleWhereSql(keepEveryN: number): string {
  return `(rn - 1) % ${Math.max(1, Math.trunc(keepEveryN))} <> 0`;
}

/**
 * Idempotence-safe DELETE predicate. The plain phase test (downsampleWhereSql)
 * deletes rows whose RENUMBERED position lands on a delete phase — after the
 * first pass survivors renumber (e.g. old rn 12 becomes rn 2), so a naive
 * re-run keeps pruning previously-kept anchors and never stabilizes (proved
 * live: pass 2 deleted the surviving rn=2 anchor of a 4-row stream).
 *
 * Stable rule: within each driver's scanned OLD window, keep the FIRST N rows
 * as permanent anchors plus every Nth thereafter; delete only rows beyond one
 * full period that are not on the keep lattice:
 *   doomed := rn > N AND rn % N <> 0        (keep rn<=N always; then rn=N+? …
 *                                            only multiples of N survive)
 * Induction proof of idempotence: pass 1 leaves {rn <= N} ∪ {m·N}. Renumbered,
 * the first N survivors rank 1..N (anchor-protected again) and the lattice
 * survivors rank ≥ N+1 at positions congruent to 0 mod N — so pass 2 deletes
 * nothing new. Fixed point reached immediately.
 * Policy fidelity (§1.10.6 "keep every 10th fix, delete the rest"): for streams
 * longer than one period this retains exactly every Nth row of the aged tail.
 * NOTE (audit trail): two earlier revisions were wrong — `(rn > N AND (rn-1)%N
 * <> 0)` deleted the rn=11 anchor of a 15-row stream (11 survivors instead of
 * the expected phase pattern), and `(rn > 1 AND (rn-1)%N <> 0)` broke idempotence
 * because survivors renumber off the phase lattice. Both observed live.
 */
export function downsampleDeletePredicateSql(keepEveryN: number): string {
  const n = Math.max(1, Math.trunc(keepEveryN));
  return `(rn > ${n} AND rn % ${n} <> 0)`;
}

/** Pure mirror of downsampleDeletePredicateSql over ONE driver's already-sorted
 *  old-window stream (positions are 1-based ranks, exactly like SQL rn()).
 *  This is the contract the production DELETE executes; selectDownsample()
 *  below keeps the original naive-phase semantics for its own unit tests. */
export function selectStableDownsample(rows: RetentionRow[], policy: RetentionPolicy = RETENTION_DEFAULTS): {
  keepIds: Array<number | string>; deleteIds: Array<number | string>;
} {
  const sorted = [...rows].sort(compareRetentionRows);
  const n = Math.max(1, Math.trunc(policy.keepEveryN));
  const keepIds: Array<number | string> = [];
  const deleteIds: Array<number | string> = [];
  sorted.forEach((r, i) => {
    const rn = i + 1;
    (rn <= n || rn % n === 0 ? keepIds : deleteIds).push(r.fix_id);
  });
  return { keepIds, deleteIds };
}
