/**
 * Module 3 — Trip Engine: PURE state machine + trip reconstruction (§1.5, §1.8.3).
 *
 * Zero I/O, zero Date.now(): everything derives from EVENT timestamps carried by the
 * data itself. This is what makes late-arriving and out-of-order batches safe:
 * a trip is reconstructed from the full sorted fix/event stream of its time window,
 * so uploading batch B before batch A (or 6 hours late) yields an IDENTICAL result.
 * That determinism IS the Phase 2 gate ("out-of-order upload == in-order upload").
 *
 * State machine (Phase 2 deliverable):
 *
 *   IDLE ──(first fix)──▶ STARTED ──▶ MOVING ◀──▶ STOPPED ──(idle timeout)──▶ ENDED
 *                             │            │           │
 *                             │            │           └─ phone >50 m from stop point
 *                             │            │              while sensors silent ─▶ DRIVER_SEPARATED
 *                             │            │              phone <30 m again     ─▶ DRIVER_RETURNED
 *                             │            └─ TURN / HARSH_* events (orthogonal)
 *                             └─ GPS_DUTY_RESUME after vibration gate reopens GPS
 *
 * Classification rules (thresholds configurable via TripConfig):
 *  - MOVING: GPS speed above movingSpeedMps, or displacement beyond stopRadiusM
 *    (GPS speed noise at standstill is why position is the fallback signal).
 *  - STOPPED: consecutive quiet fixes spanning >= stoppedAfterS (blueprint's 60 s
 *    GPS-off duty-cycle gate, applied server-side to the event stream).
 *  - Separation requires sensor silence: accelerometer/gyro samples inside the
 *    look-back window mean the phone is still on the truck (engine vibration),
 *    so no separation is flagged while motion sensors are reporting.
 */

export type FixIn = {
  t: number; // epoch millis — EVENT time from device clock (§1.8.3)
  lat: number;
  lng: number;
  speed?: number | null; // m/s reported by device
};

export type SensorIn = {
  t: number;
  kind: string; // 'accelerometer' | 'gyroscope' | 'harsh_brake' | 'harsh_accel' | 'turn' | 'vibration_gate'
  payload?: Record<string, unknown>;
};

export type TripEventType =
  | 'TRIP_STARTED' | 'MOVING' | 'STOPPED' | 'TURN' | 'HARSH_BRAKE' | 'HARSH_ACCEL'
  | 'DRIVER_SEPARATED' | 'DRIVER_RETURNED' | 'GPS_DUTY_RESUME' | 'TRIP_ENDED';

export type TripEventOut = {
  event_type: TripEventType;
  event_timestamp: number;
  lat?: number | null;
  lng?: number | null;
  payload?: Record<string, unknown>;
};

export interface TripConfig {
  movingSpeedMps: number;        // GPS speed threshold for "moving"
  minMovingDistanceM: number;    // displacement threshold (speed-noise fallback + distance filter)
  stoppedAfterS: number;         // sustained quiet period before STOPPED (blueprint: 60 s GPS-off gate)
  stopRadiusM: number;           // jitter tolerance around the recorded stop point
  separationThresholdM: number;  // §1.4 default 50 m
  returnThresholdM: number;      // §1.4 default 30 m (hysteresis vs 50 m prevents flapping)
  idleTimeoutS: number;          // no activity transition for this long => trip auto-ENDED
  sensorSilenceWindowS: number;  // look-back for "accelerometer events are absent"
}

export const DEFAULT_TRIP_CONFIG: TripConfig = {
  movingSpeedMps: 1.5,
  minMovingDistanceM: 15,
  stoppedAfterS: 60,
  stopRadiusM: 10,
  separationThresholdM: 50,
  returnThresholdM: 30,
  idleTimeoutS: 30 * 60,
  sensorSilenceWindowS: 120,
};

export type TripSummary = {
  started_at: number;
  ended_at: number;
  /**
   * 'OPEN' means: no idle timeout observed WITHIN the reconstructed data window.
   * It is NOT a claim that the trip is live — it means "cannot be closed from the
   * data we have". The DB column has no OPEN value, so the persistence layer maps
   * OPEN → last known non-terminal state (ended_at stays NULL) and lets the
   * wall-clock sweep in service.ts close the trip once real time passes the idle
   * horizon. This split is what keeps §1.8.3 determinism intact: reconstruction
   * never consults Date.now(), but stale open trips are still eventually ENDED.
   */
  final_state: 'STARTED' | 'MOVING' | 'STOPPED' | 'ENDED' | 'OPEN';
  distance_m: number;            // filtered haversine (jitter below minMovingDistanceM skipped)
  moving_duration_s: number;
  stopped_duration_s: number;
  turn_count: number;
  harsh_event_count: number;
  separation_incidents: number;
  currently_separated: boolean;
  last_fix: FixIn;
  /** Latest signal time in the reconstructed window (transition or raw fix). */
  silence_frontier_ms: number;
};

export type ReconstructedTrip = {
  events: TripEventOut[];
  summary: TripSummary;
};

const EARTH_R_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Haversine distance in meters between two WGS84 points. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Signed heading change in [-180, 180); positive = clockwise (right turn). */
export function headingDeltaDeg(prev: number, next: number): number {
  return (((next - prev) % 360) + 540) % 360 - 180;
}

/** Great-circle initial bearing (deg 0..360) from a to b. */
export function initialBearingDeg(a: Pick<FixIn, 'lat' | 'lng'>, b: Pick<FixIn, 'lat' | 'lng'>): number {
  const f1 = toRad(a.lat), f2 = toRad(b.lat), l = toRad(b.lng - a.lng);
  const y = Math.sin(l) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(l);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/**
 * Turn detection from GPS headings (§1.3: the gyro confirms turns client-side;
 * the server reconstructs them even when gyro samples were downsampled away under
 * storage pressure, §1.8.6). Consecutive bearings whose cumulative change crosses
 * `thresholdDeg` emit exactly one TURN with direction + magnitude. Headings are only
 * trusted while the vehicle is actually moving (GPS course is meaningless at rest).
 */
export function detectTurns(fixes: FixIn[], config: TripConfig, thresholdDeg = 35): TripEventOut[] {
  const out: TripEventOut[] = [];
  let heading: number | null = null;
  let accDeg = 0;
  let prev: FixIn | null = null;
  for (const f of fixes) {
    const moving = (f.speed ?? 0) > config.movingSpeedMps;
    if (!moving) { heading = null; accDeg = 0; prev = f; continue; }
    if (prev) {
      const bearing = initialBearingDeg(prev, f);
      if (heading === null) {
        heading = bearing;
      } else {
        const d = headingDeltaDeg(heading, bearing);
        if (Math.abs(d) > 8) accDeg += d; // ignore micro-jitter
        if (Math.abs(accDeg) >= thresholdDeg) {
          out.push({
            event_type: 'TURN',
            event_timestamp: f.t,
            lat: f.lat,
            lng: f.lng,
            payload: { direction: accDeg > 0 ? 'right' : 'left', delta_deg: Math.round(accDeg), source: 'gps_heading' },
          });
          accDeg = 0;
          heading = bearing;
        }
      }
    }
    prev = f;
  }
  return out;
}

/** Device-reported turn/harsh events passed through verbatim (client already fused). */
function sensorReportedEvents(sensors: SensorIn[]): TripEventOut[] {
  return sensors
    .filter((s): s is SensorIn & { kind: 'turn' | 'harsh_brake' | 'harsh_accel' } =>
      s.kind === 'turn' || s.kind === 'harsh_brake' || s.kind === 'harsh_accel')
    .map((s) => ({
      event_type: (s.kind === 'turn' ? 'TURN' : s.kind === 'harsh_brake' ? 'HARSH_BRAKE' : 'HARSH_ACCEL') as TripEventType,
      event_timestamp: s.t,
      payload: { ...(s.payload ?? {}), source: 'device_sensor' },
    }));
}

/** True if raw motion sensors were reporting in [t-window, t] — phone likely in vehicle. */
function sensorsActiveNear(sensors: SensorIn[], t: number, windowMs: number): boolean {
  return sensors.some(
    (s) => (s.kind === 'accelerometer' || s.kind === 'gyroscope') && s.t <= t && s.t >= t - windowMs,
  );
}

/**
 * Full trip reconstruction — THE deterministic kernel. Input: ALL fixes and sensor
 * events belonging to one vehicle's contiguous activity window, in ANY arrival order.
 * Output: the complete ordered event list + summary. Called identically whether data
 * arrived live, late, or out of order ⇒ identical trip state (§1.8.3 gate test).
 */
export function rebuildTrip(rawFixes: FixIn[], rawSensors: SensorIn[], cfg: Partial<TripConfig> = {}): ReconstructedTrip {
  const config = { ...DEFAULT_TRIP_CONFIG, ...cfg };
  const fixes = [...rawFixes].sort((a, b) => a.t - b.t);
  const sensors = [...rawSensors].sort((a, b) => a.t - b.t);
  if (fixes.length === 0) throw new Error('rebuildTrip requires at least one fix');

  const timeline: TripEventOut[] = [];
  const first = fixes[0]!; // length checked above
  timeline.push({ event_type: 'TRIP_STARTED', event_timestamp: first.t, lat: first.lat, lng: first.lng });

  // ---- MOVING / STOPPED segmentation + separation detection ------------------
  let state: 'STARTED' | 'MOVING' | 'STOPPED' = 'STARTED';
  let quietSince: FixIn | null = null;   // start of the current quiet run
  let stopPoint: FixIn | null = null;    // recorded truck position once STOPPED
  let separated = false;
  let separationIncidents = 0;
  let distance = 0;
  let prevCounted: FixIn | null = null;

  for (const f of fixes) {
    // Filtered haversine: skip sub-threshold jitter so stops don't inflate distance.
    if (prevCounted) {
      const dSeg = haversineM(prevCounted.lat, prevCounted.lng, f.lat, f.lng);
      if (dSeg >= config.minMovingDistanceM) {
        distance += dSeg;
        prevCounted = f;
      }
    } else prevCounted = f;

    const speedMoving = (f.speed ?? 0) > config.movingSpeedMps;
    const displacedFromStop =
      stopPoint !== null && haversineM(stopPoint.lat, stopPoint.lng, f.lat, f.lng) > config.stopRadiusM;
    const moving = speedMoving || (state === 'STARTED' && distance >= config.minMovingDistanceM) || displacedFromStop;

    if (moving) {
      // §1.4 separation check FIRST: while STOPPED, a phone that jumps >50 m from the
      // recorded stop point with sensors silent is the DRIVER walking away — the truck
      // itself cannot move silently. Resolving this before the MOVING transition keeps
      // "truck moved" (>stopRadiusM displacement) and "driver separated" (>50 m) distinct.
      if (state === 'STOPPED' && stopPoint) {
        const distFromStop = haversineM(stopPoint.lat, stopPoint.lng, f.lat, f.lng);
        const sensorsQuiet = !sensorsActiveNear(sensors, f.t, config.sensorSilenceWindowS * 1000);
        if (!separated && distFromStop > config.separationThresholdM && sensorsQuiet) {
          separated = true;
          separationIncidents++;
          timeline.push({
            event_type: 'DRIVER_SEPARATED',
            event_timestamp: f.t,
            lat: f.lat,
            lng: f.lng,
            payload: {
              truck_stop_lat: stopPoint.lat, truck_stop_lng: stopPoint.lng, stop_at: stopPoint.t,
              driver_lat: f.lat, driver_lng: f.lng,
              distance_m: Math.round(distFromStop),
            },
          });
        } else if (separated && distFromStop <= config.returnThresholdM) {
          separated = false;
          timeline.push({
            event_type: 'DRIVER_RETURNED',
            event_timestamp: f.t,
            lat: f.lat,
            lng: f.lng,
            payload: { truck_stop_lat: stopPoint.lat, truck_stop_lng: stopPoint.lng, distance_m: Math.round(distFromStop) },
          });
          // Phone back at the truck; the vibration gate reopens GPS — record duty resume.
          timeline.push({ event_type: 'GPS_DUTY_RESUME', event_timestamp: f.t, lat: f.lat, lng: f.lng,
                         payload: { reason: 'driver_returned' } });
        }
      }

      if (state !== 'MOVING') {
        timeline.push({ event_type: 'MOVING', event_timestamp: f.t, lat: f.lat, lng: f.lng });
        state = 'MOVING';
        quietSince = null;
        stopPoint = null;
      }
      // While MOVING the truck carries the phone — any open separation is resolved.
      if (separated) {
        separated = false;
        timeline.push({ event_type: 'DRIVER_RETURNED', event_timestamp: f.t, lat: f.lat, lng: f.lng,
                        payload: { reason: 'vehicle_resumed_motion' } });
      }
      continue;
    }

    // Quiet sample (low speed, not meaningfully displaced).
    if (!quietSince || haversineM(quietSince.lat, quietSince.lng, f.lat, f.lng) > config.stopRadiusM) {
      quietSince = f; // restart the stopwatch wherever the truck actually is now
    }

    // `quietSince` is non-null here: assigned unconditionally in the branch above.
    const qs = quietSince!;
    if (state !== 'STOPPED' && f.t - qs.t >= config.stoppedAfterS * 1000) {
      timeline.push({
        event_type: 'STOPPED',
        event_timestamp: qs.t,
        lat: qs.lat,
        lng: qs.lng,
        payload: { stop_lat: qs.lat, stop_lng: qs.lng, gps_duty_off: true },
      });
      state = 'STOPPED';
      stopPoint = qs;
      continue;
    }

    if (state === 'STOPPED' && stopPoint) {
      const distFromStop = haversineM(stopPoint.lat, stopPoint.lng, f.lat, f.lng);
      const sensorsQuiet = !sensorsActiveNear(sensors, f.t, config.sensorSilenceWindowS * 1000);
      if (!separated && distFromStop > config.separationThresholdM && sensorsQuiet) {
        // §1.4: truck stopped, accelerometer silent, phone moved >50 m ⇒ separation.
        separated = true;
        separationIncidents++;
        timeline.push({
          event_type: 'DRIVER_SEPARATED',
          event_timestamp: f.t,
          lat: f.lat,
          lng: f.lng,
          payload: {
            truck_stop_lat: stopPoint.lat, truck_stop_lng: stopPoint.lng, stop_at: stopPoint.t,
            driver_lat: f.lat, driver_lng: f.lng,
            distance_m: Math.round(distFromStop),
          },
        });
      } else if (separated && distFromStop <= config.returnThresholdM) {
        separated = false;
        timeline.push({
          event_type: 'DRIVER_RETURNED',
          event_timestamp: f.t,
          lat: f.lat,
          lng: f.lng,
          payload: { truck_stop_lat: stopPoint.lat, truck_stop_lng: stopPoint.lng, distance_m: Math.round(distFromStop) },
        });
        // Phone back at the truck; the vibration gate reopens GPS — record duty resume.
        timeline.push({ event_type: 'GPS_DUTY_RESUME', event_timestamp: f.t, lat: f.lat, lng: f.lng,
                       payload: { reason: 'driver_returned' } });
      }
    }
  }

  // ---- Orthogonal events: turns & harsh ---------------------------------------
  const gpsTurns = detectTurns(fixes, config);
  const reported = sensorReportedEvents(sensors);
  // Dedupe ±20 s: a device-reported TURN/HARSH_* suppresses the GPS-derived twin
  // (device fusion is more accurate; it enriches the payload instead).
  const orthogonal: TripEventOut[] = [];
  for (const e of [...gpsTurns, ...reported].sort((a, b) => a.event_timestamp - b.event_timestamp)) {
    const dup = orthogonal.find(
      (m) => m.event_type === e.event_type && Math.abs(m.event_timestamp - e.event_timestamp) <= 20_000,
    );
    if (dup) {
      if (e.payload?.source === 'device_sensor') Object.assign(dup.payload ??= {}, e.payload);
      continue;
    }
    orthogonal.push(e);
  }
  for (const e of orthogonal) timeline.push(e);
  timeline.sort((a, b) => a.event_timestamp - b.event_timestamp);

  // ---- Durations from the MOVING/STOPPED transitions (event-time segments) ----
  let movingDurationS = 0;
  let stoppedDurationS = 0;
  let segState: 'STARTED' | 'MOVING' | 'STOPPED' = 'STARTED';
  let segStart = first.t;
  const transitions = timeline.filter((e) => e.event_type === 'MOVING' || e.event_type === 'STOPPED');
  for (const e of transitions) {
    if (segState === 'MOVING') movingDurationS += (e.event_timestamp - segStart) / 1000;
    if (segState === 'STOPPED') stoppedDurationS += (e.event_timestamp - segStart) / 1000;
    segState = e.event_type as 'MOVING' | 'STOPPED';
    segStart = e.event_timestamp;
  }
  const last = fixes[fixes.length - 1]!; // length checked above
  const openEnd = last.t;
  if (segState === 'MOVING') movingDurationS += (openEnd - segStart) / 1000;
  if (segState === 'STOPPED') stoppedDurationS += (openEnd - segStart) / 1000;

  // ---- Auto-end on inactivity (pure event time; survives replay unchanged) ----
  // CRITICAL (§1.8.3): the idle check compares the END OF THE DATA WINDOW against
  // the last state transition. It NEVER consults wall-clock time — otherwise an
  // out-of-order / late replay would produce a different result than the in-order
  // upload (the control run's window is fixed at ingest time, so its trip could
  // never close while the shuffled run, recomputed later with a longer horizon,
  // closed early → non-deterministic ENDED states). When no idle gap exists inside
  // the data itself, the segment is OPEN: it may still be live, or simply the most
  // recent activity we have. Closing OPEN trips whose last ACTIVITY TIME is far in
  // the past is the job of the wall-clock sweep in service.ts (recompute + read
  // path), which is safe because it keys off stored last_activity_at, not arrival
  // order, and converges to the same terminal state for both runs.
  const lastTransition = transitions[transitions.length - 1];
  const anchor = lastTransition ? lastTransition.event_timestamp : first.t;
  // "Silence frontier": the latest moment in this data window with ANY signal —
  // a state transition or a raw fix. The wall-clock sweep measures real idle from
  // max(last_transition, last_fix_ts): fixes after the last transition still count
  // as activity (e.g. the driver walking back toward the truck during a stop keeps
  // the trip legitimately open until the phone goes truly silent).
  const silenceFrontierMs = Math.max(anchor, last.t);
  let finalState: TripSummary['final_state'];
  let endedAt = openEnd;
  if (openEnd - anchor >= config.idleTimeoutS * 1000) {
    timeline.push({ event_type: 'TRIP_ENDED', event_timestamp: openEnd, lat: last.lat, lng: last.lng,
                    payload: { reason: 'idle_timeout' } });
    finalState = 'ENDED';
  } else {
    finalState = 'OPEN';
  }

  return {
    events: timeline,
    summary: {
      started_at: first.t,
      ended_at: endedAt,
      final_state: finalState,
      distance_m: Math.round(distance),
      moving_duration_s: Math.round(movingDurationS),
      stopped_duration_s: Math.round(stoppedDurationS),
      turn_count: orthogonal.filter((e) => e.event_type === 'TURN').length,
      harsh_event_count: orthogonal.filter((e) => e.event_type === 'HARSH_BRAKE' || e.event_type === 'HARSH_ACCEL').length,
      separation_incidents: separationIncidents,
      currently_separated: separated,
      last_fix: last,
      silence_frontier_ms: silenceFrontierMs,
    },
  };
}
