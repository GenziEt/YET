import { describe, it, expect } from 'vitest';
import {
  rebuildTrip, DEFAULT_TRIP_CONFIG, DEFAULT_CLASSIFICATION_THRESHOLDS,
  classifyHarshEvents, classifyTurnEvents, classifyRawMotionEvents,
  type FixIn, type SensorIn, type ClassificationThresholds,
} from '../src/modules/trip_engine/state_machine.js';

/**
 * Phase 2 completion-gate tests (implementation instruction §Phase 2):
 *  * threshold-boundary behavior of the server-side fusion classifiers
 *    (below / exactly-at / above the calibrated limits — kernel semantics:
 *    inclusive crossing `a <= -brake || a >= accel`, sustained-run `>=` for
 *    turns, and `magnitude >= limit` at emission);
 *  * shuffled-input equivalence of the classifiers themselves (multiset
 *    determinism, §1.8.3) — complements the existing rebuildTrip gate test;
 *  * dedupe priority through rebuildTrip: device > server-fused > GPS-derived
 *    within ±20 s, with payload enrichment assertions;
 *  * the published config payload key contract consumed by the driver-app
 *    classifier (event_classifier.dart ClassificationThresholds.fromJson).
 *
 * NOTE: fusion only activates when cfg.classification is set; these tests pass
 * it explicitly. DEFAULT_TRIP_CONFIG leaves it undefined, so the pre-existing
 * trip_state_machine tests are unaffected by the fusion path.
 */

const T0 = Date.parse('2026-10-20T08:00:00Z');
const S = 1000;
const TH: ClassificationThresholds = DEFAULT_CLASSIFICATION_THRESHOLDS; // 3.5 / 2.5 / 35 dps / 1000 ms / gap 2000 / cooldown 5000

function accel(t: number, x: number, z = 9.81): SensorIn {
  return { t, kind: 'accelerometer', payload: { values: [x, 0, z] } };
}
function gyro(t: number, zRadPerS: number): SensorIn {
  return { t, kind: 'gyroscope', payload: { values: [0, 0, zRadPerS] } };
}
/** rad/s → deg/s inverse of the kernel's convention (§1.3: z = yaw axis). */
const dps = (d: number) => (d * Math.PI) / 180;

function shuffle<T>(arr: T[], seed = 7): T[] {
  const a = [...arr];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('classifyHarshEvents threshold boundaries (§1.3)', () => {
  // One excursion per window (> cooldownMs apart) so each case emits independently.
  const W = 10_000;

  it('BELOW limit: no event when peak magnitude < threshold', () => {
    const sensors = [
      accel(T0, 0), accel(T0 + 1000, -3.4), accel(T0 + 2000, -3.4), accel(T0 + 3000, 0),
    ];
    expect(classifyHarshEvents(sensors, TH)).toEqual([]);
  });

  it('AT limit: exactly -harshBrakeMps2 crosses inclusively and emits HARSH_BRAKE', () => {
    const sensors = [
      accel(T0, 0), accel(T0 + 1000, -TH.harshBrakeMps2), accel(T0 + 2000, -TH.harshBrakeMps2), accel(T0 + 3000, 0),
    ];
    const ev = classifyHarshEvents(sensors, TH);
    expect(ev.length).toBe(1);
    expect(ev[0]!.event_type).toBe('HARSH_BRAKE');
    expect(ev[0]!.payload?.magnitude_mps2).toBe(TH.harshBrakeMps2);
    expect(ev[0]!.payload?.source).toBe('server_fusion');
  });

  it('ABOVE limit: deeper deceleration emits with reported magnitude', () => {
    const sensors = [
      accel(T0, 0), accel(T0 + 1000, -5.2), accel(T0 + 2000, -4.0), accel(T0 + 3000, 0),
    ];
    const ev = classifyHarshEvents(sensors, TH);
    expect(ev.length).toBe(1);
    expect(ev[0]!.event_type).toBe('HARSH_BRAKE');
    expect(ev[0]!.payload?.magnitude_mps2).toBeCloseTo(5.2, 2);
  });

  it('acceleration side: below/at/around harshAccelMps2', () => {
    const below = [accel(T0, 0), accel(T0 + 1000, 2.4), accel(T0 + 2000, 2.4), accel(T0 + 3000, 0)];
    expect(classifyHarshEvents(below, TH)).toEqual([]);
    const at = [accel(T0 + W, 0), accel(T0 + W + 1000, TH.harshAccelMps2), accel(T0 + W + 2000, TH.harshAccelMps2), accel(T0 + W + 3000, 0)];
    const ev = classifyHarshEvents(at, TH);
    expect(ev.length).toBe(1);
    expect(ev[0]!.event_type).toBe('HARSH_ACCEL');
  });

  it('one event per excursion (peak grouping, not per-sample spam)', () => {
    // A single long braking excursion: many samples over the limit → ONE event.
    const sensors = Array.from({ length: 8 }, (_, i) => accel(T0 + i * 500, -4.5));
    const ev = classifyHarshEvents(sensors, TH);
    expect(ev.length).toBe(1);
    expect(ev[0]!.payload?.onset_t).toBeDefined();
    expect(ev[0]!.payload?.release_t).toBeDefined();
  });

  it('cooldown suppresses a second peak within cooldownMs', () => {
    // Two distinct braking excursions 4 s apart (< 5 s cooldown): only the first emits.
    const sensors = [
      accel(T0, 0), accel(T0 + 1000, -5.0), accel(T0 + 2000, -5.0), accel(T0 + 3000, 0),
      accel(T0 + 5000, -5.0), accel(T0 + 6000, -5.0), accel(T0 + 7000, 0),
    ];
    const ev = classifyHarshEvents(sensors, TH);
    expect(ev.length).toBe(1);
  });

  it('excursions beyond cooldownMs both emit', () => {
    const sensors = [
      accel(T0, 0), accel(T0 + 1000, -5.0), accel(T0 + 2000, 0),
      accel(T0 + 8000, 0), accel(T0 + 9000, -5.0), accel(T0 + 10000, 0),
    ];
    const ev = classifyHarshEvents(sensors, TH);
    expect(ev.length).toBe(2);
  });

  it('fewer than 3 accelerometer samples cannot classify', () => {
    expect(classifyHarshEvents([accel(T0, -9), accel(T0 + 1000, -9)], TH)).toEqual([]);
  });

  it('sideways phone: dominant-variance z axis is picked as longitudinal', () => {
    // x carries only noise; z carries the braking excursion → axis='z'.
    const sensors = [
      accel(T0, 0.1, 9.81), accel(T0 + 1000, -0.1, 9.81),
      accel(T0 + 2000, 0.05, 4.5), accel(T0 + 3000, -0.05, 4.3), accel(T0 + 4000, 0, 9.81),
    ];
    const ev = classifyHarshEvents(sensors, TH);
    expect(ev.length).toBe(1);
    expect(ev[0]!.payload?.axis).toBe('z');
  });
});

describe('classifyTurnEvents threshold boundaries (§1.3)', () => {
  it('BELOW rate limit: no TURN even when sustained', () => {
    const sensors = Array.from({ length: 6 }, (_, i) => gyro(T0 + i * 500, dps(34)));
    expect(classifyTurnEvents(sensors, TH)).toEqual([]);
  });

  it('AT rate limit but BELOW min duration (single sample): no TURN', () => {
    const sensors = [gyro(T0, dps(TH.turnRateDps)), gyro(T0 + 5000, 0)];
    expect(classifyTurnEvents(sensors, TH)).toEqual([]);
  });

  it('AT limit sustained >= turnMinDurationMs emits exactly one TURN', () => {
    // 0..1000 ms at exactly the threshold → run duration 1000 >= 1000 (inclusive).
    const sensors = [
      gyro(T0, dps(TH.turnRateDps)), gyro(T0 + 500, dps(TH.turnRateDps)), gyro(T0 + 1000, dps(TH.turnRateDps)),
    ];
    const ev = classifyTurnEvents(sensors, TH);
    expect(ev.length).toBe(1);
    expect(ev[0]!.event_type).toBe('TURN');
    expect(ev[0]!.payload?.duration_ms).toBe(TH.turnMinDurationMs);
    expect(ev[0]!.payload?.source).toBe('server_fusion_gyro');
  });

  it('direction follows sign of yaw (+ right, - left)', () => {
    const right = classifyTurnEvents([gyro(T0, dps(60)), gyro(T0 + 1000, dps(60))], TH);
    expect(right[0]!.payload?.direction).toBe('right');
    const left = classifyTurnEvents([gyro(T0 + 20_000, dps(-60)), gyro(T0 + 21_000, dps(-60))], TH);
    expect(left[0]!.payload?.direction).toBe('left');
  });

  it('gap longer than maxSampleGapMs breaks the run (no cross-gap fusion)', () => {
    // Samples at 0 s and 3 s (> 2 s gap): each run is 0 ms long → below duration.
    const sensors = [gyro(T0, dps(60)), gyro(T0 + 3000, dps(60))];
    expect(classifyTurnEvents(sensors, TH)).toEqual([]);
  });

  it('one TURN per sustained run regardless of sample count', () => {
    const sensors = Array.from({ length: 10 }, (_, i) => gyro(T0 + i * 500, dps(70)));
    const ev = classifyTurnEvents(sensors, TH);
    expect(ev.length).toBe(1);
    expect(ev[0]!.payload?.peak_rate_dps).toBeCloseTo(70, 0);
  });
});

describe('classifier multiset determinism (§1.8.3 gate)', () => {
  const mixedSensors: SensorIn[] = [
    accel(T0, 0), accel(T0 + 1000, -5.0), accel(T0 + 2000, -4.0), accel(T0 + 3000, 0),
    accel(T0 + 20_000, 3.0), accel(T0 + 21_000, 3.2), accel(T0 + 22_000, 0),
    gyro(T0 + 40_000, dps(60)), gyro(T0 + 40_500, dps(65)), gyro(T0 + 41_000, dps(60)),
    gyro(T0 + 60_000, dps(-55)), gyro(T0 + 61_000, dps(-55)),
  ];

  it('classifyHarshEvents output identical under shuffled input', () => {
    const ordered = classifyHarshEvents(mixedSensors, TH);
    expect(ordered.length).toBeGreaterThan(0);
    for (const seed of [1, 2, 3, 99]) {
      expect(classifyHarshEvents(shuffle(mixedSensors, seed), TH)).toEqual(ordered);
    }
  });

  it('classifyTurnEvents output identical under shuffled input', () => {
    const ordered = classifyTurnEvents(mixedSensors, TH);
    expect(ordered.length).toBeGreaterThan(0);
    for (const seed of [1, 2, 3, 99]) {
      expect(classifyTurnEvents(shuffle(mixedSensors, seed), TH)).toEqual(ordered);
    }
  });

  it('classifyRawMotionEvents (combined) output identical under shuffled input', () => {
    const ordered = classifyRawMotionEvents(mixedSensors, TH);
    expect(ordered.length).toBeGreaterThan(0);
    for (const seed of [5, 13, 42]) {
      expect(classifyRawMotionEvents(shuffle(mixedSensors, seed), TH)).toEqual(ordered);
    }
  });
});

describe('rebuildTrip dedupe priority: device > server-fused > gps (§Phase 2)', () => {
  function straightRun(n: number, startT: number): FixIn[] {
    // Due north, ~111 m per 0.001 deg — no heading change ⇒ no GPS-derived TURN.
    return Array.from({ length: n }, (_, i) => ({
      t: startT + i * 30 * S, lat: +(9.03 + i * 0.001).toFixed(7), lng: 38.74, speed: 14,
    }));
  }

  it('device-reported HARSH_BRAKE suppresses the fused twin and enriches its payload', () => {
    const fixes = straightRun(6, T0);
    // classifyHarshEvents needs >= 3 samples; a run at exactly -brake with x
    // variance below z variance picks axis z (gravity constant ⇒ no false
    // harsh-accel companion), mirroring a phone mounted sideways.
    const brakeRun = [accel(T0 + 64 * S, 0, 9.81), accel(T0 + 65 * S, 0, 4.81), accel(T0 + 66 * S, 0, 4.81)];
    const deviceEvent: SensorIn = {
      t: T0 + 65 * S, kind: 'harsh_brake',
      payload: { magnitude_mps2: 5.0, threshold_mps2: TH.harshBrakeMps2, source_hint: 'device' },
    };
    const cfg = { ...DEFAULT_TRIP_CONFIG, classification: TH };
    const withDevice = rebuildTrip(fixes, [...brakeRun, deviceEvent], cfg);
    const withoutDevice = rebuildTrip(fixes, brakeRun, cfg);

    const brakes = (r: typeof withDevice) => r.events.filter((e) => e.event_type === 'HARSH_BRAKE');
    expect(brakes(withoutDevice).length).toBe(1); // fused fallback reconstructs the lost event
    expect(brakes(withoutDevice)[0]!.payload?.source).toBe('server_fusion');

    expect(brakes(withDevice).length).toBe(1); // NOT two — deduped within ±20 s
    expect(brakes(withDevice)[0]!.payload?.source).toBe('device_sensor');
    // Enrichment: fused metadata merged into the surviving device event.
    expect(brakes(withDevice)[0]!.payload?.threshold_mps2).toBe(TH.harshBrakeMps2);
    expect(brakes(withDevice)[0]!.payload?.axis).toBeDefined();
    expect(withDevice.summary.harsh_event_count).toBe(withoutDevice.summary.harsh_event_count);
  });

  it('fused event suppresses a GPS-derived TURN twin and overrides its payload', () => {
    // Heading sequence that makes detectTurns fire once (~45 deg right turn):
    // north, north, then east-ish leg.
    const fixes: FixIn[] = [
      { t: T0, lat: 9.03, lng: 38.74, speed: 14 },
      { t: T0 + 30 * S, lat: 9.031, lng: 38.74, speed: 14 },
      { t: T0 + 60 * S, lat: 9.032, lng: 38.74, speed: 14 },
      { t: T0 + 90 * S, lat: 9.0325, lng: 38.745, speed: 14 },
      { t: T0 + 120 * S, lat: 9.033, lng: 38.75, speed: 14 },
    ];
    const cfg = { ...DEFAULT_TRIP_CONFIG, classification: TH };
    const gpsOnly = rebuildTrip(fixes, [], cfg);
    const turnsGps = gpsOnly.events.filter((e) => e.event_type === 'TURN');
    expect(turnsGps.length).toBe(1); // sanity: the fixture really produces a GPS TURN
    expect(turnsGps[0]!.payload?.source).toBe('gps_heading');

    // Gyro run overlapping the GPS turn time (>1 s sustained) → fused TURN twin.
    const gyroSensors: SensorIn[] = [
      gyro(turnsGps[0]!.event_timestamp - 500, dps(60)),
      gyro(turnsGps[0]!.event_timestamp, dps(60)),
      gyro(turnsGps[0]!.event_timestamp + 500, dps(60)),
    ];
    const fused = rebuildTrip(fixes, gyroSensors, cfg);
    const turnsFused = fused.events.filter((e) => e.event_type === 'TURN');
    expect(turnsFused.length).toBe(1); // deduped against the GPS twin
    // Priority: server-fused replaces the weaker gps-derived payload…
    expect(turnsFused[0]!.payload?.source).toBe('server_fusion_gyro');
    // …and reports the gyro run metadata.
    expect(turnsFused[0]!.payload?.peak_rate_dps).toBeCloseTo(60, 0);

    // Device-reported turn wins over BOTH: survives as device_sensor with fused enrichment.
    const deviceTurn: SensorIn = {
      t: turnsGps[0]!.event_timestamp + 2000, kind: 'turn',
      payload: { direction: 'right', peak_rate_dps: 62 },
    };
    const withDevice = rebuildTrip(fixes, [...gyroSensors, deviceTurn], cfg);
    const turnsDev = withDevice.events.filter((e) => e.event_type === 'TURN');
    expect(turnsDev.length).toBe(1);
    expect(turnsDev[0]!.payload?.source).toBe('device_sensor');
    expect(turnsDev[0]!.payload?.peak_rate_dps).toBe(62); // device value not overwritten by fused
  });

  it('fusion is OFF unless cfg.classification is provided (default bootstrap unaffected)', () => {
    const fixes = straightRun(6, T0);
    const brakeRun = [accel(T0 + 65 * S, -5.0), accel(T0 + 66 * S, -5.0), accel(T0 + 67 * S, -5.0)];
    const off = rebuildTrip(fixes, brakeRun, DEFAULT_TRIP_CONFIG);
    expect(off.events.filter((e) => e.event_type === 'HARSH_BRAKE').length).toBe(0);
    const on = rebuildTrip(fixes, brakeRun, { classification: TH });
    expect(on.events.filter((e) => e.event_type === 'HARSH_BRAKE').length).toBe(1);
  });

  it('dedupe outcome is order-independent: shuffled fixes+sensors give identical events', () => {
    const fixes = straightRun(6, T0);
    const sensors: SensorIn[] = [
      accel(T0 + 65 * S, -5.0), accel(T0 + 66 * S, -5.0),
      { t: T0 + 65 * S, kind: 'harsh_brake', payload: { magnitude_mps2: 5.0 } },
      gyro(T0 + 100_000, dps(70)), gyro(T0 + 101_000, dps(70)),
    ];
    const cfg = { ...DEFAULT_TRIP_CONFIG, classification: TH };
    const ordered = rebuildTrip(fixes, sensors, cfg);
    for (const seed of [3, 11, 77]) {
      const shuffled = rebuildTrip(shuffle(fixes, seed), shuffle(sensors, seed + 1), cfg);
      expect(shuffled.events).toEqual(ordered.events);
      expect(shuffled.summary).toEqual(ordered.summary);
    }
  });
});

describe('classification-config wire contract (driver-app parser)', () => {
  it('published payload keys match ClassificationThresholds.fromJson snake_case expectations', async () => {
    process.env.DATABASE_URL ??= 'postgres://x:y@localhost:5432/z';
    process.env.JWT_SECRET ??= 'test-secret-0123456789abcdef';
    const { classificationConfigPayload, CLASSIFICATION_CONFIG } = await import('../src/modules/trip_engine/service.js');
    const p = classificationConfigPayload();
    expect(p.policy).toBe('trip-classification-v1');
    // Exactly the keys lib/features/trip/event_classifier.dart reads:
    expect(Object.keys(p.thresholds).sort()).toEqual([
      'cooldown_ms', 'harsh_accel_mps2', 'harsh_brake_mps2', 'max_sample_gap_ms',
      'turn_min_duration_ms', 'turn_rate_dps', 'vibration_gate_variance',
    ]);
    // Values come from validated env config — never hardcoded elsewhere.
    expect(p.thresholds.harsh_brake_mps2).toBe(CLASSIFICATION_CONFIG.harshBrakeMps2);
    expect(p.thresholds.harsh_accel_mps2).toBe(CLASSIFICATION_CONFIG.harshAccelMps2);
    expect(p.thresholds.turn_rate_dps).toBe(CLASSIFICATION_CONFIG.turnRateDps);
    expect(p.thresholds.turn_min_duration_ms).toBe(CLASSIFICATION_CONFIG.turnMinDurationMs);
    expect(p.sampling.sample_interval_ms).toBe(2000);
  });
});
