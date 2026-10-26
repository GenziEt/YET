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
  /** Phase 2 (§1.3): calibrated classification thresholds for the server-side raw
   *  sample fusion below. When null, raw-sample fallback stays disabled and only
   *  device-reported discrete events count (legacy behavior). */
  classification?: ClassificationThresholds | null;
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

/* ---------------------------------------------------------------------------
 * Phase 2 — server-side sensor FUSION / CLASSIFICATION (§1.3)
 *
 * The driver app classifies harsh braking / harsh acceleration / turns ON DEVICE
 * (lib/features/trip/event_classifier.dart) using the calibrated thresholds
 * published by GET /trips/classification-config (env.ts HARSH_* and TURN_*). Those
 * discrete events arrive as kind='harsh_brake' | 'harsh_accel' | 'turn' and are
 * passed through verbatim above. But §1.8.6 lets the client evict/downsample
 * under storage pressure and OEM ROMs occasionally kill the collector mid-trip,
 * so raw accelerometer/gyroscope samples can be ALL the evidence we have. This
 * pure kernel reconstructs the same discrete events from raw samples with the
 * SAME configured thresholds — no magic numbers anywhere; every constant comes
 * from ClassificationThresholds, which is fed from validated env config.
 * ------------------------------------------------------------------------- */

export interface ClassificationThresholds {
  /** Longitudinal deceleration peak counted as harsh braking (m/s², positive magnitude). */
  harshBrakeMps2: number;
  /** Longitudinal acceleration peak counted as harsh acceleration (m/s²). */
  harshAccelMps2: number;
  /** Gyroscope |z| angular velocity for turn detection (deg/s). */
  turnRateDps: number;
  /** … that must persist at least this long (§1.3: > 1 second), milliseconds. */
  turnMinDurationMs: number;
  /** Consecutive-sample gap beyond which a run is broken (no cross-gap fusion). */
  maxSampleGapMs: number;
  /** Cooldown after an emitted event of the same kind (peak = one event). */
  cooldownMs: number;
}

export const DEFAULT_CLASSIFICATION_THRESHOLDS: ClassificationThresholds = {
  harshBrakeMps2: 3.5,
  harshAccelMps2: 2.5,
  turnRateDps: 35,
  turnMinDurationMs: 1000,
  maxSampleGapMs: 2000,
  cooldownMs: 5000,
};

type SampleAxis = 'x' | 'y' | 'z';

function sampleValues(s: SensorIn): number[] | null {
  const v = (s.payload as Record<string, unknown> | undefined)?.values;
  if (!Array.isArray(v)) return null;
  const nums = v.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : NaN));
  return nums.length === 3 && nums.every(Number.isFinite) ? nums : null;
}

/**
 * Harsh-braking / harsh-acceleration peaks from longitudinal acceleration.
 * Device coordinate convention (documented + calibrated per trip, §1.3):
 *   x = forward · y = right · z = up; gravity ≈ +9.81 on z.
 * Longitudinal axis = x when it carries the dominant variance (phone flat),
 * otherwise z (phone mounted sideways) — a cheap automatic axis pick so the
 * threshold contract holds across placements. A "peak" is a signed sample
 * crossing ±threshold, grouped into ONE event per excursion (cooldown); the
 * event reports magnitude and the timestamp of the extreme sample.
 * Deterministic pure function of the sample multiset sorted by time ⇒ safe for
 * out-of-order replay (§1.8.3).
 */
export function classifyHarshEvents(
  sensors: SensorIn[],
  th: ClassificationThresholds = DEFAULT_CLASSIFICATION_THRESHOLDS,
): TripEventOut[] {
  const accel = sensors
    .filter((s) => s.kind === 'accelerometer')
    .map((s) => ({ t: s.t, v: sampleValues(s) }))
    .filter((s): s is { t: number; v: number[] } => s.v !== null)
    .sort((a, b) => a.t - b.t);
  if (accel.length < 3) return [];

  // Axis pick: whichever horizontal-ish axis has the greatest variance beyond
  // gravity is treated as longitudinal. Pure function of the samples.
  const variance = (idx: number) => {
    const xs = accel.map((a) => a.v[idx]!);
    const mean = xs.reduce((p, c) => p + c, 0) / xs.length;
    return xs.reduce((p, c) => p + (c - mean) ** 2, 0) / xs.length;
  };
  const longitudinal: SampleAxis = variance(0) >= variance(2) ? 'x' : 'z';
  const li = longitudinal === 'x' ? 0 : 2;

  const out: TripEventOut[] = [];
  let lastEmittedAt = -Infinity;
  let run: { sign: 1 | -1; extreme: number; extremeT: number; startT: number; endT: number } | null = null;

  const closeRun = () => {
    if (!run) return;
    const magnitude = Math.abs(run.extreme);
    const kind: TripEventType = run.sign < 0 ? 'HARSH_BRAKE' : 'HARSH_ACCEL';
    const limit = run.sign < 0 ? th.harshBrakeMps2 : th.harshAccelMps2;
    if (magnitude >= limit && run.extremeT - lastEmittedAt > th.cooldownMs) {
      out.push({
        event_type: kind,
        event_timestamp: run.extremeT,
        payload: {
          magnitude_mps2: +magnitude.toFixed(2),
          threshold_mps2: limit,
          axis: longitudinal,
          onset_t: run.startT,
          release_t: run.endT,
          source: 'server_fusion',
        },
      });
      lastEmittedAt = run.extremeT;
    }
    run = null;
  };

  for (const s of accel) {
    const a = s.v[li]!;
    const overLimit = a <= -th.harshBrakeMps2 || a >= th.harshAccelMps2;
    const sign: 1 | -1 = a < 0 ? -1 : 1;
    if (overLimit) {
      if (run && run.sign === sign && s.t - run.endT <= th.maxSampleGapMs) {
        run.endT = s.t;
        if (Math.abs(a) > Math.abs(run.extreme)) { run.extreme = a; run.extremeT = s.t; }
      } else {
        closeRun();
        if (a < 0 ? a <= -th.harshBrakeMps2 : a >= th.harshAccelMps2) {
          run = { sign, extreme: a, extremeT: s.t, startT: s.t, endT: s.t };
        }
      }
    } else if (run && s.t - run.endT > th.maxSampleGapMs) {
      closeRun();
    }
  }
  closeRun();
  return out;
}

/**
 * Turn events from RAW gyroscope samples (§1.3: angular velocity > threshold
 * sustained > minimum duration). Continuous |z| runs exceeding the rate
 * threshold for at least turnMinDurationMs emit exactly one TURN per run,
 * carrying direction (sign), peak rate and run duration. Same-input-same-output
 * pure function; deterministic under reordering because samples are sorted here.
 */
export function classifyTurnEvents(
  sensors: SensorIn[],
  th: ClassificationThresholds = DEFAULT_CLASSIFICATION_THRESHOLDS,
): TripEventOut[] {
  const gyro = sensors
    .filter((s) => s.kind === 'gyroscope')
    .map((s) => ({ t: s.t, v: sampleValues(s) }))
    .filter((s): s is { t: number; v: number[] } => s.v !== null)
    .sort((a, b) => a.t - b.t);

  const out: TripEventOut[] = [];
  let run: { sign: 1 | -1; startT: number; lastT: number; peakDps: number; peakT: number } | null = null;
  const radToDeg = 180 / Math.PI;

  const closeRun = () => {
    if (!run) return;
    if (run.lastT - run.startT >= th.turnMinDurationMs) {
      out.push({
        event_type: 'TURN',
        event_timestamp: run.peakT,
        payload: {
          direction: run.sign > 0 ? 'right' : 'left',
          peak_rate_dps: +Math.abs(run.peakDps).toFixed(1),
          threshold_dps: th.turnRateDps,
          duration_ms: run.lastT - run.startT,
          onset_t: run.startT,
          source: 'server_fusion_gyro',
        },
      });
    }
    run = null;
  };

  for (const s of gyro) {
    const zDeg = s.v[2]! * radToDeg; // device convention: z = yaw axis (§1.3)
    if (Math.abs(zDeg) >= th.turnRateDps) {
      const sign: 1 | -1 = zDeg > 0 ? 1 : -1;
      if (run && run.sign === sign && s.t - run.lastT <= th.maxSampleGapMs) {
        run.lastT = s.t;
        if (Math.abs(zDeg) > Math.abs(run.peakDps)) { run.peakDps = zDeg; run.peakT = s.t; }
      } else {
        closeRun();
        run = { sign, startT: s.t, lastT: s.t, peakDps: zDeg, peakT: s.t };
      }
    } else if (run && s.t - run.lastT > th.maxSampleGapMs) {
      closeRun();
    }
  }
  closeRun();
  return out;
}

/**
 * Vibration-gate state transitions from raw accelerometer variance (§1.3 engine
 * vibration gate): variance crosses MOTION_VARIANCE_THRESHOLD ⇒ 'moving', falls
 * below ⇒ 'stopped'. Emitted so the trip record shows WHY GPS duty-cycled; the
 * kernel's separation logic already treats raw samples as "phone on truck" via
 * sensorsActiveNear, so these enrich rather than change state semantics.
 */
export function classifyVibrationGateEvents(
  sensors: SensorIn[],
  varianceThreshold: number,
): TripEventOut[] {
  const accel = sensors
    .filter((s) => s.kind === 'accelerometer')
    .map((s) => ({ t: s.t, v: sampleValues(s) }))
    .filter((s): s is { t: number; v: number[] } => s.v !== null)
    .sort((a, b) => a.t - b.t);
  if (accel.length < 3) return [];
  const varOf = (win: { v: number[] }[]) => {
    const zs = win.map((w) => w.v[2]!);
    const mean = zs.reduce((p, c) => p + c, 0) / zs.length;
    return zs.reduce((p, c) => p + (c - mean) ** 2, 0) / zs.length;
  };
  const out: TripEventOut[] = [];
  let moving: boolean | null = null;
  const WINDOW = 3;
  for (let i = WINDOW - 1; i < accel.length; i++) {
    const variance = varOf(accel.slice(i - WINDOW + 1, i + 1));
    const nowMoving = variance >= varianceThreshold;
    if (moving !== null && nowMoving !== moving) {
      out.push({
        event_type: 'GPS_DUTY_RESUME',
        event_timestamp: accel[i]!.t,
        payload: {
          reason: nowMoving ? 'vibration_gate_open' : 'vibration_gate_close',
          variance: +variance.toFixed(4),
          threshold: varianceThreshold,
          source: 'server_fusion_gate',
        },
      });
    }
    moving = nowMoving;
  }
  return out;
}

/**
 * Full fallback fusion: derive discrete device-equivalent events from raw
 * samples so they join the dedupe pass against device-reported ones. Returns
 * HARSH_* / TURN only (gate events stay separate to avoid polluting counts).
 */
export function classifyRawMotionEvents(
  sensors: SensorIn[],
  th: ClassificationThresholds = DEFAULT_CLASSIFICATION_THRESHOLDS,
): TripEventOut[] {
  return [...classifyHarshEvents(sensors, th), ...classifyTurnEvents(sensors, th)]
    .sort((a, b) => a.event_timestamp - b.event_timestamp);
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
  // Phase 2 raw-sample fusion (§1.3): reconstruct HARSH_*/TURN from the raw
  // accelerometer/gyro stream using the SAME calibrated thresholds the device
  // uses — so trips whose discrete events were lost to §1.8.6 eviction or a
  // mid-trip collector kill still get classified. Pure function of the sample
  // multiset ⇒ identical output for in-order and out-of-order arrival (§1.8.3).
  const fused = config.classification ? classifyRawMotionEvents(sensors, config.classification) : [];
  // Dedupe ±20 s: a device-reported TURN/HARSH_* suppresses the GPS/fused twin
  // (device fusion is more accurate; it enriches the payload instead). Priority
  // order in the dedupe pass: device > server-fused > gps-derived.
  const orthogonal: TripEventOut[] = [];
  for (const e of [...gpsTurns, ...fused, ...reported].sort((a, b) => a.event_timestamp - b.event_timestamp)) {
    const dup = orthogonal.find(
      (m) => m.event_type === e.event_type && Math.abs(m.event_timestamp - e.event_timestamp) <= 20_000,
    );
    if (dup) {
      const src = e.payload?.source;
      if (src === 'device_sensor' || (src === 'server_fusion' && dup.payload?.source !== 'device_sensor')) {
        Object.assign(dup.payload ??= {}, e.payload);
      }
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
