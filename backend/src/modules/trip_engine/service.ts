import { pool } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import {
  rebuildTrip, DEFAULT_TRIP_CONFIG,
  type FixIn, type SensorIn, type TripEventOut, type ReconstructedTrip,
} from './state_machine.js';

/**
 * Module 3 — Trip Engine (§1.5). Consumes Ingest's raw data; owns trips,
 * trip_events, driver_separation_log. It NEVER trusts arrival order: every ingest
 * batch triggers a full EVENT-TIME reconstruction of the affected vehicle window
 * (§1.8.3), and results are written with idempotent upserts keyed by
 * (trip_id, event_type, event_timestamp) — verbatim from the Offline Contract.
 *
 * Why recompute-whole-window instead of an incremental reducer?
 *  - Incremental reducers corrupt state when offline replay delivers B before A
 *    (the exact failure §1.8.3 forbids). Reconstruction is deterministic in the
 *    multiset of events, so any upload order converges to one identical trip.
 *  - Pilot-scale windows (≤ a few hours of ≤30 s fixes ≈ hundreds of rows) keep
 *    the recomputation far inside the API budget (§1.9.4); extraction trigger for
 *    a streaming rewrite is documented in docs/ARCHITECTURE.md.
 */

export const TRIP_CONFIG = {
  ...DEFAULT_TRIP_CONFIG,
  stoppedAfterS: env.TRIP_STOPPED_AFTER_S,
  separationThresholdM: env.TRIP_SEPARATION_THRESHOLD_M,
  returnThresholdM: env.TRIP_RETURN_THRESHOLD_M,
  idleTimeoutS: env.TRIP_IDLE_TIMEOUT_S,
};

type FixRow = { fix_timestamp: Date; lat: number; lng: number; speed_mps: number | null };
type SensorRow = { event_timestamp: Date; kind: string; payload: Record<string, unknown> };

async function loadWindow(vehicleId: string, fromMs: number, toMs: number): Promise<{ fixes: FixIn[]; sensors: SensorIn[] }> {
  const { rows: fixRows } = await pool.query<FixRow>(
    `SELECT fix_timestamp, lat, lng, speed_mps FROM location_fixes
      WHERE vehicle_id=$1 AND fix_timestamp >= $2 AND fix_timestamp <= $3
      ORDER BY fix_timestamp ASC`,
    [vehicleId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );
  const { rows: sensorRows } = await pool.query<SensorRow>(
    `SELECT event_timestamp, kind, payload FROM sensor_events
      WHERE vehicle_id=$1 AND event_timestamp >= $2 AND event_timestamp <= $3
      ORDER BY event_timestamp ASC`,
    [vehicleId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );
  return {
    fixes: fixRows.map((r) => ({ t: r.fix_timestamp.getTime(), lat: r.lat, lng: r.lng, speed: r.speed_mps })),
    sensors: sensorRows.map((r) => ({ t: r.event_timestamp.getTime(), kind: r.kind, payload: r.payload ?? {} })),
  };
}

/**
 * Split a window's fixes into independent trips wherever the event-time gap
 * exceeds idleTimeoutS. Pure function of sorted timestamps ⇒ same split for any
 * arrival order (a late batch that bridges two segments merges them deterministically).
 */
export function segmentTrips(fixes: FixIn[], idleTimeoutMs: number): FixIn[][] {
  if (fixes.length === 0) return [];
  const first = fixes[0]!;
  const segs: FixIn[][] = [[first]];
  for (let i = 1; i < fixes.length; i++) {
    const cur = fixes[i]!, prev = fixes[i - 1]!;
    if (cur.t - prev.t > idleTimeoutMs) segs.push([cur]);
    else segs[segs.length - 1]!.push(cur);
  }
  return segs;
}

/**
 * Persist one reconstructed segment. Returns { tripId, closed }:
 *  - closed=true when the row is (or became) ENDED with ended_at set — either from
 *    an in-data idle gap (final_state==='ENDED'), or because the wall-clock sweep
 *    had already force-closed this exact started_at and we must not reopen it.
 * The OPEN state (§1.8.3-safe reconstruction) maps to the last known non-terminal
 * state with ended_at=NULL; closeOpenTrips() ends it once REAL time passes the
 * idle horizon measured from last ACTIVITY TIME (event time), never arrival time.
 */
async function upsertTripRow(driverId: string, vehicleId: string, rec: ReconstructedTrip): Promise<{ tripId: string; closed: boolean }> {
  const s = rec.summary;
  // Sweep may have force-closed a trip for this exact started_at BEFORE this
  // reconstruction ran (e.g. late batch recomputing an already-expired window).
  // Respect that closure: reopening would make the end state depend on arrival
  // order, violating §1.8.3 convergence.
  const { rows: existing } = await pool.query(
    `SELECT trip_id, ended_at IS NOT NULL AS closed FROM trips
      WHERE driver_id=$1 AND vehicle_id=$2 AND started_at=$3`,
    [driverId, vehicleId, new Date(s.started_at).toISOString()],
  );
  if (existing[0]?.closed) return { tripId: existing[0].trip_id as string, closed: true };

  const closedFromData = s.final_state === 'ENDED';
  const endedAt = closedFromData ? new Date(s.ended_at).toISOString() : null;
  const persistedState = closedFromData
    ? 'ENDED'
    : s.final_state === 'OPEN'
      ? lastNonTerminalState(rec) // OPEN is kernel-only; DB enum has no such value
      : s.final_state;
  // The open-trip partial unique index (uq_trips_open_vehicle) can collide when a
  // reconstruction closes an old trip while opening a newer one in the same window.
  // Retry with the conflicting row force-ended — still fully event-time derived.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO trips (driver_id, vehicle_id, started_at, ended_at, last_activity_at, state,
                            stop_lat, stop_lng, stop_at, distance_m, moving_duration_s,
                            stopped_duration_s, turn_count, harsh_event_count, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}')
         ON CONFLICT (driver_id, vehicle_id, started_at) DO UPDATE SET
           ended_at = EXCLUDED.ended_at,
           last_activity_at = GREATEST(trips.last_activity_at, EXCLUDED.last_activity_at),
           state = EXCLUDED.state,
           stop_lat = EXCLUDED.stop_lat, stop_lng = EXCLUDED.stop_lng, stop_at = EXCLUDED.stop_at,
           distance_m = EXCLUDED.distance_m,
           moving_duration_s = EXCLUDED.moving_duration_s,
           stopped_duration_s = EXCLUDED.stopped_duration_s,
           turn_count = EXCLUDED.turn_count,
           harsh_event_count = EXCLUDED.harsh_event_count,
           updated_at = now()
         RETURNING trip_id`,
        [driverId, vehicleId, new Date(s.started_at).toISOString(), endedAt,
         new Date(s.last_fix.t).toISOString(), persistedState,
         stopPointOf(rec), stopLngOf(rec), stopAtOf(rec),
         s.distance_m, s.moving_duration_s, s.stopped_duration_s, s.turn_count, s.harsh_event_count],
      );
      return { tripId: rows[0]!.trip_id as string, closed: closedFromData };
    } catch (err: any) {
      if (err?.code === '23505' && String(err.detail ?? '').includes('uq_trips_open_vehicle')) {
        // Force-end the stale open trip at its own last activity (event time), then retry.
        await pool.query(
          `UPDATE trips SET ended_at = last_activity_at, state='ENDED', updated_at=now()
            WHERE vehicle_id=$1 AND ended_at IS NULL AND started_at < $2`,
          [vehicleId, new Date(s.started_at).toISOString()],
        );
        continue;
      }
      throw err;
    }
  }
  throw new Error('trip upsert failed after conflict retries');
}

/** Map kernel OPEN → a valid trip_state enum value for storage. */
function lastNonTerminalState(rec: ReconstructedTrip): 'STARTED' | 'MOVING' | 'STOPPED' {
  const e = [...rec.events].reverse().find(
    (x) => x.event_type === 'MOVING' || x.event_type === 'STOPPED') as TripEventOut | undefined;
  return (e?.event_type as 'MOVING' | 'STOPPED') ?? 'STARTED';
}

/**
 * WALL-CLOCK SWEEP (§1.8.3-safe closure of OPEN trips). A reconstruction can only
 * see data through its ingest window frontier; trips whose silence horizon lies
 * beyond that frontier stay OPEN forever unless something compares their last
 * ACTIVITY TIME against real elapsed time. This does that: for every open trip of
 * this vehicle whose max(last_activity_at, last MOVING/STOPPED transition) +
 * idleTimeoutS < now, force-close it AT its last activity (pure event time) and
 * stamp TRIP_ENDED(idle_timeout, source:sweep).
 * Determinism holds because:
 *  - the kernel never returns ENDED for these segments in ANY run (OPEN is
 *    window-frontier independent), so control and shuffled runs both rely on this
 *    sweep, and both converge to the identical terminal state ENDED@lastActivity;
 *  - upsertTripRow refuses to reopen a sweep-closed started_at;
 *  - recompute skips event/log writes for already-closed trips.
 */
async function closeOpenTrips(vehicleId: string, nowMs: number): Promise<void> {
  const { rows } = await pool.query(
    `SELECT t.trip_id, t.driver_id,
            COALESCE(GREATEST(t.last_activity_at,
                              (SELECT max(event_timestamp) FROM trip_events
                                WHERE trip_id = t.trip_id AND event_type IN ('MOVING','STOPPED'))),
                     t.last_activity_at) AS last_signal_at
       FROM trips t
      WHERE t.vehicle_id = $1 AND t.ended_at IS NULL`,
    [vehicleId],
  );
  const horizonMs = nowMs - TRIP_CONFIG.idleTimeoutS * 1000;
  for (const r of rows) {
    if (new Date(r.last_signal_at).getTime() > horizonMs) continue; // still within live horizon
    const endedAtIso = new Date(r.last_signal_at).toISOString();
    await pool.query(
      `UPDATE trips SET ended_at = $2, state='ENDED', updated_at=now()
        WHERE trip_id=$1 AND ended_at IS NULL`,
      [r.trip_id, endedAtIso],
    );
    // Idempotent terminal event — same upsert key as the reconstruction kernel uses.
    // Coordinates: last fix at-or-before the closing moment (the truck's final known spot).
    await pool.query(
      `INSERT INTO trip_events (trip_id, vehicle_id, driver_id, event_type, event_timestamp, lat, lng, payload)
       SELECT $1, $2, $3, 'TRIP_ENDED', $4, lf.lat, lf.lng, '{"reason":"idle_timeout","source":"sweep"}'::jsonb
         FROM (SELECT lat, lng FROM location_fixes
                WHERE vehicle_id=$2 AND fix_timestamp <= $4
                ORDER BY fix_timestamp DESC LIMIT 1) lf
         ON CONFLICT (trip_id, event_type, event_timestamp) DO NOTHING`,
      // NOTE: never `ON CONFLICT ON CONSTRAINT uq_trip_event` — that syntax fails
      // with 42P10 because uq_trip_event is a UNIQUE *index* (migration 0008),
      // not a table constraint. Inferred-columns form works for both.
      [r.trip_id, vehicleId, r.driver_id, endedAtIso],
    );
  }
}

function stopPointOf(rec: ReconstructedTrip): number | null {
  const e = [...rec.events].reverse().find((x) => x.event_type === 'STOPPED');
  return e?.lat ?? null;
}
function stopLngOf(rec: ReconstructedTrip): number | null {
  const e = [...rec.events].reverse().find((x) => x.event_type === 'STOPPED');
  return e?.lng ?? null;
}
function stopAtOf(rec: ReconstructedTrip): string | null {
  const e = [...rec.events].reverse().find((x) => x.event_type === 'STOPPED');
  return e ? new Date(e.event_timestamp).toISOString() : null;
}

async function upsertEvents(tripId: string, vehicleId: string, driverId: string, events: TripEventOut[]) {
  for (const e of events) {
    // Idempotent upsert by (trip_id, event_type, event_timestamp) — §1.8.3 hard rule.
    await pool.query(
      `INSERT INTO trip_events (trip_id, vehicle_id, driver_id, event_type, event_timestamp, lat, lng, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (trip_id, event_type, event_timestamp) DO UPDATE SET
         lat = EXCLUDED.lat, lng = EXCLUDED.lng, payload = EXCLUDED.payload, updated_at = now()`,
      [tripId, vehicleId, driverId, e.event_type, new Date(e.event_timestamp).toISOString(),
       e.lat ?? null, e.lng ?? null, JSON.stringify(e.payload ?? {})],
    );
  }
}

/** Maintain driver_separation_log (§1.4) from the reconstructed timeline. */
async function syncSeparationLog(tripId: string, vehicleId: string, driverId: string, events: TripEventOut[]) {
  for (const e of events) {
    if (e.event_type === 'DRIVER_SEPARATED') {
      const p = e.payload ?? {};
      await pool.query(
        `INSERT INTO driver_separation_log
           (trip_id, vehicle_id, driver_id, separated_at, truck_stop_lat, truck_stop_lng,
            driver_lat, driver_lng, distance_m)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (trip_id, separated_at) DO UPDATE SET
           truck_stop_lat = EXCLUDED.truck_stop_lat, truck_stop_lng = EXCLUDED.truck_stop_lng,
           driver_lat = EXCLUDED.driver_lat, driver_lng = EXCLUDED.driver_lng,
           distance_m = EXCLUDED.distance_m, updated_at = now()`,
        [tripId, vehicleId, driverId, new Date(e.event_timestamp).toISOString(),
         p.truck_stop_lat, p.truck_stop_lng, p.driver_lat ?? e.lat, p.driver_lng ?? e.lng,
         p.distance_m ?? 0],
      );
    } else if (e.event_type === 'DRIVER_RETURNED') {
      // Clear the open incident whose separation precedes this return (event time).
      await pool.query(
        `UPDATE driver_separation_log
            SET returned_at = $2, status = 'RETURNED', updated_at = now()
          WHERE trip_id = $1 AND returned_at IS NULL AND separated_at <= $2`,
        [tripId, new Date(e.event_timestamp).toISOString()],
      );
    }
  }
}

/**
 * THE entry point: called by Ingest after each accepted batch (fire-and-forget with
 * error logging — ingest ACK must not wait on trip logic) and by the read path for
 * self-healing. Recomputes every trip overlapping the given event-time window.
 *
 * Serialized per vehicle via an in-process promise chain (§1.8.3). Two concurrent
 * recomputations of overlapping windows race: reconstruction closes/opens trips
 * transactionally per window, so interleaving can violate uq_trips_open_vehicle or
 * double-insert events between a conflict-check and its retry. Out-of-order offline
 * replay delivers batches back-to-back; chaining makes them converge deterministically.
 * Coalescing: if a recompute is already queued for this vehicle, merge the requested
 * window into it instead of growing the queue unboundedly.
 */
interface QueuedWindow { from: number; to: number; tail: Promise<void> }
const recomputeChains = new Map<string, QueuedWindow>();

export function recomputeVehicleWindow(vehicleId: string, driverId: string, fromMs: number, toMs: number): Promise<void> {
  const existing = recomputeChains.get(vehicleId);
  if (existing) {
    existing.from = Math.min(existing.from, fromMs);
    existing.to = Math.max(existing.to, toMs);
    return existing.tail;
  }
  const q: QueuedWindow = { from: fromMs, to: toMs, tail: Promise.resolve() };
  recomputeChains.set(vehicleId, q);
  q.tail = (async () => {
    // Drain: run until no new window has been merged while we were executing.
    for (;;) {
      const { from, to } = q;
      try {
        await recomputeVehicleWindowUnlocked(vehicleId, driverId, from, to);
      } finally {
        // Release the slot BEFORE re-checking so a late merge can take over.
        const stillOurs = recomputeChains.get(vehicleId) === q;
        if (stillOurs && q.from === from && q.to === to) recomputeChains.delete(vehicleId);
        if (!stillOurs || (q.from === from && q.to === to)) break;
        if (!recomputeChains.has(vehicleId)) recomputeChains.set(vehicleId, q);
      }
    }
  })();
  return q.tail;
}

async function recomputeVehicleWindowUnlocked(vehicleId: string, driverId: string, fromMs: number, toMs: number): Promise<void> {
  const { fixes, sensors } = await loadWindow(vehicleId, fromMs, toMs);
  if (fixes.length === 0) return;
  const segments = segmentTrips(fixes.sort((a, b) => a.t - b.t), TRIP_CONFIG.idleTimeoutS * 1000);
  for (const seg of segments) {
    const lo = seg[0]!.t - TRIP_CONFIG.sensorSilenceWindowS * 1000; // include look-back sensors
    const hi = seg[seg.length - 1]!.t;
    const windowSensors = sensors.filter((s) => s.t >= lo && s.t <= hi);
    const rec = rebuildTrip(seg, windowSensors, TRIP_CONFIG);
    const { tripId, closed } = await upsertTripRow(driverId, vehicleId, rec);
    if (closed) continue; // sweep already ended this trip — do not rewrite events/state (§1.8.3 convergence)
    await upsertEvents(tripId, vehicleId, driverId, rec.events);
    await syncSeparationLog(tripId, vehicleId, driverId, rec.events);
  }
  // Wall-clock sweep: close OPEN trips whose last ACTIVITY TIME is past the idle
  // horizon in REAL time. Runs after reconstruction so freshly-closed-in-data trips
  // are already ENDED and only genuinely stale open rows are touched.
  await closeOpenTrips(vehicleId, Date.now());
  await audit({ action: 'trip_recompute', targetUser: driverId, detail: { vehicle_id: vehicleId, from_ms: fromMs, to_ms: toMs } });
}

/** Window expansion for a newly ingested batch: min..max event time ± grace. */
export function batchWindowMs(times: number[]): { from: number; to: number } {
  const min = Math.min(...times), max = Math.max(...times);
  const graceS = TRIP_CONFIG.sensorSilenceWindowS + 60;
  return { from: min - graceS * 1000, to: max + 60_000 };
}

/* ---------------------------------------------------------------------------
 * Internal API (§1.5 Module 3): "get current trip status for vehicle X".
 * Read-your-writes guarantee: if stored state looks stale relative to the newest
 * raw fix (an earlier recompute failed / process died mid-batch), reconstruct now.
 * ------------------------------------------------------------------------- */

export interface TripStatus {
  trip_id: string;
  vehicle_id: string;
  driver_id: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  last_activity_at: string;
  stop_location: { lat: number; lng: number; at: string } | null;
  separation: {
    separated_at: string; minutes_since: number;
    truck_last_known: { lat: number; lng: number };
    driver: { lat: number; lng: number };
    notify_fleet_manager: boolean;   // true once past TRIP_SEPARATION_NOTIFY_MIN (§1.4 45-min timer)
  } | null;
  summary: {
    distance_m: number; moving_duration_s: number; stopped_duration_s: number;
    turn_count: number; harsh_event_count: number; separation_incidents: number;
  };
}

async function getOrRecoverActiveTrip(vehicleId: string): Promise<any | null> {
  // Sweep first (read-path closure, §1.8.3-safe: keys off stored EVENT times —
  // last_activity_at / last transition — compared against real elapsed time, never
  // arrival order). Trips whose silence horizon passed in wall-clock close here
  // even when no new data ever arrives to trigger a recompute.
  await closeOpenTrips(vehicleId, Date.now());
  const { rows } = await pool.query(`SELECT * FROM trips WHERE vehicle_id=$1 AND ended_at IS NULL`, [vehicleId]);
  const open = rows[0] ?? null;
  // Self-heal: compare against raw ingest frontier.
  const { rows: frontier } = await pool.query(
    `SELECT max(fix_timestamp) AS latest FROM location_fixes WHERE vehicle_id=$1
       AND fix_timestamp > COALESCE($2::timestamptz, '-infinity')`,
    [vehicleId, open?.last_activity_at ?? null],
  );
  if (frontier[0]?.latest) {
    const latestMs = new Date(frontier[0].latest).getTime();
    const fromMs = open ? new Date(open.started_at).getTime() - 2 * 3600_000 : latestMs - 24 * 3600_000;
    await recomputeVehicleWindow(vehicleId, open?.driver_id ?? (await driverOfVehicle(vehicleId)) ?? vehicleId, fromMs, latestMs + 60_000);
    const { rows: again } = await pool.query(`SELECT * FROM trips WHERE vehicle_id=$1 AND ended_at IS NULL`, [vehicleId]);
    return again[0] ?? open;
  }
  return open;
}

async function driverOfVehicle(vehicleId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT driver_id FROM driver_vehicle_assignments WHERE vehicle_id=$1 AND unassigned_at IS NULL LIMIT 1`,
    [vehicleId],
  );
  return rows[0]?.driver_id ?? null;
}

export async function getTripStatusForVehicle(vehicleId: string): Promise<TripStatus | null> {
  const trip = await getOrRecoverActiveTrip(vehicleId);
  if (!trip) return null;
  let sep: TripStatus['separation'] = null;
  const { rows: openSep } = await pool.query(
    `SELECT * FROM driver_separation_log WHERE trip_id=$1 AND returned_at IS NULL ORDER BY separated_at DESC LIMIT 1`,
    [trip.trip_id],
  );
  if (openSep[0]) {
    const s = openSep[0];
    const minutes = (Date.now() - new Date(s.separated_at).getTime()) / 60000;
    sep = {
      separated_at: new Date(s.separated_at).toISOString(),
      minutes_since: Math.round(minutes),
      truck_last_known: { lat: s.truck_stop_lat, lng: s.truck_stop_lng },
      driver: { lat: s.driver_lat, lng: s.driver_lng },
      // §1.4: never claim live truck tracking — dashboard labels the truck marker
      // "last known location" using truck_last_known + separated timestamp.
      notify_fleet_manager: minutes >= env.TRIP_SEPARATION_NOTIFY_MIN,
    };
  }
  return {
    trip_id: trip.trip_id, vehicle_id: trip.vehicle_id, driver_id: trip.driver_id,
    state: trip.state,
    started_at: new Date(trip.started_at).toISOString(),
    ended_at: trip.ended_at ? new Date(trip.ended_at).toISOString() : null,
    last_activity_at: new Date(trip.last_activity_at).toISOString(),
    stop_location: trip.stop_lat != null
      ? { lat: trip.stop_lat, lng: trip.stop_lng, at: new Date(trip.stop_at).toISOString() }
      : null,
    separation: sep,
    summary: {
      distance_m: Number(trip.distance_m), moving_duration_s: Number(trip.moving_duration_s),
      stopped_duration_s: Number(trip.stopped_duration_s), turn_count: trip.turn_count,
      harsh_event_count: trip.harsh_event_count, separation_incidents: 0,
    },
  };
}

/* ----------------------------- Dashboard reads ----------------------------- */

/**
 * Dashboard trip list (§1.5 Module 3 reads). Sweeps stale open trips before
 * serving: closure is derived from stored EVENT times vs real elapsed time, so a
 * fleet manager polling /trips sees ENDED (not a phantom 'active') for any trip
 * whose last activity predates the idle horizon — without waiting for new data.
 */
export async function listTrips(q: { driver_id?: string; vehicle_id?: string; from?: string; to?: string; limit: number; status?: string }) {
  // Cheap sweep on the read path (indexed on vehicle partial-open rows).
  const { rows: openVehicles } = await pool.query(
    `SELECT DISTINCT vehicle_id FROM trips WHERE ended_at IS NULL`);
  for (const r of openVehicles) await closeOpenTrips(r.vehicle_id as string, Date.now());
  const conds: string[] = [];
  const params: unknown[] = [];
  const push = (sql: string, v: unknown) => { conds.push(sql); params.push(v); };
  if (q.driver_id) push('t.driver_id = $' + (params.length + 1), q.driver_id);
  if (q.vehicle_id) push('t.vehicle_id = $' + (params.length + 1), q.vehicle_id);
  if (q.from) push('t.started_at >= $' + (params.length + 1), q.from);
  if (q.to) push('t.started_at < $' + (params.length + 1), q.to);
  if (q.status === 'active') conds.push('t.ended_at IS NULL');
  if (q.status === 'ended') conds.push('t.ended_at IS NOT NULL');
  if (q.status === 'separation') conds.push(`EXISTS (SELECT 1 FROM driver_separation_log dsl WHERE dsl.trip_id = t.trip_id AND dsl.returned_at IS NULL)`);
  params.push(q.limit);
  const { rows } = await pool.query(
    `SELECT t.*, u.full_name AS driver_name, v.plate_number,
            EXISTS (SELECT 1 FROM driver_separation_log dsl
                     WHERE dsl.trip_id = t.trip_id AND dsl.returned_at IS NULL) AS has_open_separation
       FROM trips t
       JOIN users u ON u.id = t.driver_id
       LEFT JOIN vehicles v ON v.id = t.vehicle_id
      ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      ORDER BY t.started_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    trip_id: r.trip_id, driver_id: r.driver_id, driver_name: r.driver_name,
    vehicle_id: r.vehicle_id, plate_number: r.plate_number,
    started_at: r.started_at, ended_at: r.ended_at, state: r.state,
    status: r.ended_at ? (r.has_open_separation ? 'separation_alert' : 'ended')
                       : (r.has_open_separation ? 'separation_alert' : 'active'),
    distance_m: Number(r.distance_m), moving_duration_s: Number(r.moving_duration_s),
    stopped_duration_s: Number(r.stopped_duration_s),
    turn_count: r.turn_count, harsh_event_count: r.harsh_event_count,
    has_open_separation: r.has_open_separation,
  }));
}

export async function getTripDetail(tripId: string) {
  const { rows: tripRows } = await pool.query(
    `SELECT t.*, u.full_name AS driver_name, v.plate_number FROM trips t
     JOIN users u ON u.id=t.driver_id LEFT JOIN vehicles v ON v.id=t.vehicle_id WHERE t.trip_id=$1`,
    [tripId],
  );
  const trip = tripRows[0];
  if (!trip) return null;
  const { rows: events } = await pool.query(
    `SELECT event_type, event_timestamp, lat, lng, payload FROM trip_events
      WHERE trip_id=$1 ORDER BY event_timestamp ASC, created_at ASC`, [tripId]);
  const { rows: separations } = await pool.query(
    `SELECT * FROM driver_separation_log WHERE trip_id=$1 ORDER BY separated_at ASC`, [tripId]);
  return {
    trip: {
      trip_id: trip.trip_id, driver_id: trip.driver_id, driver_name: trip.driver_name,
      vehicle_id: trip.vehicle_id, plate_number: trip.plate_number,
      started_at: trip.started_at, ended_at: trip.ended_at, state: trip.state,
      distance_m: Number(trip.distance_m), moving_duration_s: Number(trip.moving_duration_s),
      stopped_duration_s: Number(trip.stopped_duration_s), turn_count: trip.turn_count,
      harsh_event_count: trip.harsh_event_count, metadata: trip.metadata,
    },
    events: events.map((e) => ({
      event_type: e.event_type, event_timestamp: e.event_timestamp,
      lat: e.lat, lng: e.lng, payload: e.payload,
    })),
    separations: separations.map((s) => ({
      separation_id: s.separation_id, status: s.status,
      separated_at: s.separated_at, returned_at: s.returned_at,
      truck_last_known: { lat: s.truck_stop_lat, lng: s.truck_stop_lng },
      driver: { lat: s.driver_lat, lng: s.driver_lng },
      distance_m: s.distance_m,
      duration_minutes: s.returned_at
        ? Math.round((new Date(s.returned_at).getTime() - new Date(s.separated_at).getTime()) / 60000)
        : null,
    })),
  };
}
