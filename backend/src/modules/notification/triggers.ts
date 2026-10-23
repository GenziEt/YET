/**
 * Module 5 — Notification: composition-root triggers (Phase 5, A4/A5).
 *
 * Same late-binding pattern as geofence/crossing.ts: Ingest fires the recompute
 * hook after each accepted batch; app.ts chains these evaluators AFTER trip
 * reconstruction + crossing persistence so notifications attach to trips/events
 * that already exist. Notification owns NO trip logic (§1.5) — it only READS
 * trip_events / driver_separation_log rows owned by Trip Engine and Geofence.
 *
 * Determinism (§1.8.3): every queue call derives its dedupe key from EVENT times
 * stored in the DB, so a window recomputed ten times (or an offline batch replayed
 * six hours late) re-derives the same keys and ON CONFLICT DO NOTHING makes the
 * whole pass a no-op. Fire-once lives in two layers:
 *   - TRIP / GEOFENCE events: uq_notif_dedupe on (event_type, 'trip:<id>:<type>:<ts>').
 *   - DRIVER_SEPARATION_TIMER: the durable notified_fleet_manager marker (below)
 *     plus per-recipient dedupe keys inside enqueueNotification.
 */

import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { decideSeparationTimer, separationDedupeKey, SEPARATION_NOTIFY_MIN_DEFAULT } from './kernel.js';
import { notifyTripEvent, notifyGeofenceCrossing, notifySeparationTimer } from './service.js';

/**
 * Scan trip_events newly written for this vehicle's event-time window and queue
 * TRIP_STARTED / TRIP_ENDED / GEOFENCE_ENTER / GEOFENCE_EXIT alerts. Plate numbers
 * come from the vehicles table (delivery text needs them; coordinates never leave
 * the ledger — enqueue stores redacted detail only).
 */
export async function runNotificationTrigger(args: {
  vehicleId: string; driverId: string; fromMs: number; toMs: number;
}): Promise<{ queued: number }> {
  const { rows } = await pool.query(
    `SELECT te.trip_id, te.event_type,
            EXTRACT(EPOCH FROM te.event_timestamp) * 1000 AS ts_ms,
            v.plate_number,
            te.payload ->> 'name' AS zone_name,
            t.distance_m
       FROM trip_events te
       JOIN trips t    ON t.trip_id = te.trip_id
       LEFT JOIN vehicles v ON v.id = te.vehicle_id
      WHERE te.vehicle_id = $1
        AND te.event_timestamp >= $2 AND te.event_timestamp <= $3
        AND te.event_type IN ('TRIP_STARTED','TRIP_ENDED','GEOFENCE_ENTER','GEOFENCE_EXIT')
      ORDER BY te.event_timestamp ASC, te.trip_id ASC`,
    [args.vehicleId, new Date(args.fromMs).toISOString(), new Date(args.toMs).toISOString()],
  );

  let queued = 0;
  for (const r of rows) {
    const tsMs = Number(r.ts_ms);
    const distanceM = r.distance_m != null ? Number(r.distance_m) : null;
    if (r.event_type === 'TRIP_STARTED' || r.event_type === 'TRIP_ENDED') {
      // TRIP_STARTED renders without {{distance_km}} (kernel blanks it honestly);
      // TRIP_ENDED reports the reconstructed trip distance.
      queued += await notifyTripEvent({
        eventType: r.event_type,
        tripId: r.trip_id,
        driverId: args.driverId,
        vehicleId: args.vehicleId,
        plateNumber: r.plate_number ?? null,
        eventTimestampMs: tsMs,
        distanceM: r.event_type === 'TRIP_ENDED' ? distanceM : null,
      });
    } else {
      // GEOFENCE_ENTER/EXIT: zone name persisted in payload by crossing.ts.
      queued += await notifyGeofenceCrossing({
        eventType: r.event_type,
        tripId: r.trip_id,
        driverId: args.driverId,
        vehicleId: args.vehicleId,
        plateNumber: r.plate_number ?? null,
        geofenceName: r.zone_name ?? '—',
        eventTimestampMs: tsMs,
      });
    }
  }
  return { queued };
}

/**
 * §1.4 separation-timer sweep. Selects OPEN incidents not yet flagged notified
 * (partial index idx_separation_unnotified from 0011 keeps this cheap), runs the
 * PURE kernel verdict with the scan instant passed in (never read in-kernel), and
 * on FIRED atomically claims the incident: UPDATE ... WHERE notified_fleet_manager
 * = false RETURNING — so concurrent sweeps (two processes, or sweep vs trigger)
 * cannot both proceed past the claim. The queue call itself is then idempotent via
 * uq_notif_dedupe, and SKIPPED/FAILED dispatches still count as "the fleet manager
 * was told once" per the honest-ledger design (no unbounded retry storms).
 */
export async function runSeparationSweep(nowMs: number = Date.now()): Promise<{ fired: number; scanned: number }> {
  const thresholdMin = env.TRIP_SEPARATION_NOTIFY_MIN || SEPARATION_NOTIFY_MIN_DEFAULT;
  const { rows } = await pool.query(
    `SELECT d.separation_id, d.driver_id, d.vehicle_id, d.trip_id,
            EXTRACT(EPOCH FROM d.separated_at) * 1000 AS separated_ms,
            v.plate_number
       FROM driver_separation_log d
       LEFT JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.returned_at IS NULL AND d.notified_fleet_manager = false
      ORDER BY d.separated_at ASC
      LIMIT 100`,
  );

  let fired = 0;
  for (const d of rows) {
    const decision = decideSeparationTimer({
      separatedAtMs: Number(d.separated_ms),
      nowMs,
      thresholdMin,
      alreadyNotified: false, // filtered in SQL; kept explicit for kernel honesty
    });
    if (!decision.fire) continue;
    // Atomic claim BEFORE queueing: exactly one sweep wins per incident.
    const { rows: claimed } = await pool.query(
      `UPDATE driver_separation_log
          SET notified_fleet_manager = true, status = 'NOTIFIED', updated_at = now()
        WHERE separation_id = $1 AND notified_fleet_manager = false
        RETURNING separation_id`,
      [d.separation_id],
    );
    if (!claimed[0]) continue; // lost the race to another sweep — correct no-op
    const queuedN = await notifySeparationTimer({
      separationId: d.separation_id,
      driverId: d.driver_id,
      vehicleId: d.vehicle_id,
      plateNumber: d.plate_number ?? null,
      minutesSince: decision.minutes_since,
    });
    if (queuedN > 0) fired++;
  }
  return { fired, scanned: rows.length };
}

/**
 * TEST-HARNESS ONLY (§1.8.3 replay-determinism gate): force an OPEN separation
 * incident past its threshold WITHOUT mutating event-time history. The honest
 * production path is runSeparationSweep(nowMs) — real elapsed time decides. For
 * integration gates we need to prove FIRED → NOTIFIED → dedupe → re-run no-op in
 * seconds, not after TRIP_SEPARATION_NOTIFY_MIN of wall clock. This helper shifts
 * separated_at back by (threshold + 1) minutes via a RETURNING CTE so the very
 * next sweep pass sees minutes_since >= threshold and fires through the SAME code
 * path (claim UPDATE, notifySeparationTimer fan-out, uq_notif_dedupe). Idempotent:
 * already-notified incidents are untouched; re-calling after a shift is a no-op
 * because returned_at IS NULL AND notified_fleet_manager = false no longer matches.
 */
export async function testForceSeparationOverdue(separationId: string): Promise<{ shifted: boolean }> {
  const thresholdMin = env.TRIP_SEPARATION_NOTIFY_MIN || SEPARATION_NOTIFY_MIN_DEFAULT;
  const { rows } = await pool.query(
    `UPDATE driver_separation_log
        SET separated_at = separated_at - make_interval(mins => $2::int)
      WHERE separation_id = $1 AND returned_at IS NULL AND notified_fleet_manager = false
      RETURNING separation_id`,
    [separationId, thresholdMin + 1],
  );
  return { shifted: rows.length > 0 };
}

/** Test-harness read: current per-recipient dedupe keys queued for one incident. */
export async function testSeparationDedupeKeys(separationId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT dedupe_key FROM notification_log
      WHERE event_type = 'DRIVER_SEPARATION_TIMER' AND dedupe_key LIKE $1
      ORDER BY dedupe_key`,
    [`${separationDedupeKey(separationId)}@%`],
  );
  return rows.map((r) => r.dedupe_key);
}

let sweepTimer: NodeJS.Timeout | null = null;

/** Periodic §1.4 timer loop (composition root starts it; interval from env). */
export function startSeparationSweepLoop(intervalMs = env.NOTIFY_SEPARATION_SWEEP_S * 1000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    runSeparationSweep().catch((err) =>
      console.warn('[notify-separation] sweep failed:', err?.message ?? err));
  }, intervalMs);
  sweepTimer.unref?.();
}

export function stopSeparationSweepLoop(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
