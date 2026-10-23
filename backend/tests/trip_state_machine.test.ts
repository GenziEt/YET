import { describe, it, expect } from 'vitest';
import {
  rebuildTrip, haversineM, DEFAULT_TRIP_CONFIG,
  type FixIn, type SensorIn,
} from '../src/modules/trip_engine/state_machine.js';

/**
 * Phase 2 gate tests — PURE state machine (§1.8.3).
 * The blueprint's gate: "Upload a batch out of order and confirm trip state is
 * identical to in-order upload." At the kernel level this means: rebuildTrip must
 * be a deterministic function of the MULTISET of fixes/sensors, not their order.
 */

const T0 = Date.parse('2026-10-20T08:00:00Z');
const S = 1000;

/** ~1 deg lat ≈ 111 km; small deltas below are meter-scale. */
function movingRun(n: number, startT: number, base = { lat: 9.03, lng: 38.74 }): FixIn[] {
  const out: FixIn[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ t: startT + i * 30 * S, lat: +(base.lat + i * 0.001).toFixed(7), lng: base.lng, speed: 14 });
  }
  return out;
}

function shuffle<T>(arr: T[], seed = 42): T[] {
  const a = [...arr];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('haversine sanity', () => {
  it('computes meter-scale distances', () => {
    expect(haversineM(9.03, 38.74, 9.03, 38.74)).toBeCloseTo(0, 5);
    // 0.001 deg latitude ≈ 111 m
    expect(haversineM(9.03, 38.74, 9.031, 38.74)).toBeGreaterThan(100);
    expect(haversineM(9.03, 38.74, 9.03, 38.74)).toBeLessThan(1);
  });
});

describe('rebuildTrip determinism (Phase 2 gate §1.8.3)', () => {
  const fixes = [
    ...movingRun(6, T0),                                    // drive 0..150 s
    // stopped run: quiet >= 60 s at a fixed point
    { t: T0 + 180 * S, lat: 9.036, lng: 38.74, speed: 0 },
    { t: T0 + 240 * S, lat: 9.036, lng: 38.74, speed: 0 },
    { t: T0 + 300 * S, lat: 9.036, lng: 38.74, speed: 0 },
    // driver walks away with phone: >50 m while sensors silent
    { t: T0 + 360 * S, lat: 9.0369, lng: 38.74, speed: 0 },   // ~100 m
    { t: T0 + 420 * S, lat: 9.0369, lng: 38.74, speed: 0 },
    // driver returns within 30 m of stop point
    { t: T0 + 900 * S, lat: 9.03605, lng: 38.74, speed: 0 },
    // resumed motion
    ...movingRun(4, T0 + 960 * S, { lat: 9.0362, lng: 38.74 }),
  ];
  const sensors: SensorIn[] = [
    { t: T0 + 10 * S, kind: 'accelerometer', payload: { var: 0.4 } },
    { t: T0 + 100 * S, kind: 'gyroscope', payload: { z: 0.2 } },
    { t: T0 + 55 * S, kind: 'turn', payload: { direction: 'right', delta_deg: 47 } },
  ];

  it('shuffled input produces IDENTICAL events + summary as ordered input', () => {
    const ordered = rebuildTrip(fixes, sensors, DEFAULT_TRIP_CONFIG);
    for (const seed of [1, 7, 42, 1337]) {
      const shuffled = rebuildTrip(shuffle(fixes, seed), shuffle(sensors, seed + 1), DEFAULT_TRIP_CONFIG);
      expect(shuffled.events).toEqual(ordered.events);
      expect(shuffled.summary).toEqual(ordered.summary);
    }
  });

  it('splitting into "late batches" and merging back yields the same result', () => {
    // Simulate offline replay: batch A (first half) uploads, then batch B (second
    // half) arrives 6 hours late. The engine re-runs on the union ⇒ identical state.
    const whole = rebuildTrip(fixes, sensors, DEFAULT_TRIP_CONFIG);
    const half = Math.ceil(fixes.length / 2);
    const union = rebuildTrip([...fixes.slice(half), ...fixes.slice(0, half)], sensors, DEFAULT_TRIP_CONFIG);
    expect(union.events).toEqual(whole.events);
    expect(union.summary).toEqual(whole.summary);
  });

  it('emits the expected event vocabulary for the scenario above', () => {
    const { events, summary } = rebuildTrip(fixes, sensors, DEFAULT_TRIP_CONFIG);
    const types = events.map((e) => e.event_type);
    expect(types[0]).toBe('TRIP_STARTED');
    expect(types).toContain('MOVING');
    expect(types).toContain('STOPPED');
    expect(types).toContain('DRIVER_SEPARATED');
    expect(types).toContain('DRIVER_RETURNED');
    expect(types).toContain('TURN');
    expect(summary.separation_incidents).toBe(1);
    expect(summary.turn_count).toBeGreaterThanOrEqual(1);
  });
});

describe('separation semantics (§1.4)', () => {
  // NOTE: separation is only meaningful while the truck stays parked — a fix that
  // moves > stopRadiusM from the stop point is classified as the vehicle MOVING
  // (the phone-moved-with-truck case). The scenario below keeps every post-stop
  // fix at low GPS speed so the state machine treats displacement as the DRIVER
  // walking with the phone, not the truck driving.
  const stopFix = (t: number, lat: number): FixIn => ({ t, lat, lng: 38.74, speed: 0 });
  const base: FixIn[] = [
    ...movingRun(4, T0),                       // drive
    stopFix(T0 + 150 * S, 9.036),              // quiet #1
    stopFix(T0 + 210 * S, 9.036),              // quiet #2 (>=60 s span ⇒ STOPPED)
    stopFix(T0 + 270 * S, 9.036),              // still parked
  ];

  it('flags DRIVER_SEPARATED with BOTH truck-stop and driver locations', () => {
    const far = stopFix(T0 + 330 * S, 9.0369); // ~100 m from stop point
    const { events } = rebuildTrip([...base, far], [], DEFAULT_TRIP_CONFIG);
    const sep = events.find((e) => e.event_type === 'DRIVER_SEPARATED');
    expect(sep).toBeDefined();
    expect(sep!.payload?.truck_stop_lat).toBeCloseTo(9.036, 6);
    expect(sep!.payload?.driver_lat).toBeCloseTo(9.0369, 6);
    expect(Number(sep!.payload?.distance_m)).toBeGreaterThan(50);
  });

  it('does NOT flag separation when accelerometer/gyro are reporting (phone on truck)', () => {
    const far = stopFix(T0 + 330 * S, 9.0369);
    const sensors: SensorIn[] = [
      { t: T0 + 300 * S, kind: 'accelerometer', payload: { var: 0.5 } }, // within 120 s look-back
    ];
    const { events } = rebuildTrip([...base, far], sensors, DEFAULT_TRIP_CONFIG);
    expect(events.some((e) => e.event_type === 'DRIVER_SEPARATED')).toBe(false);
  });

  it('movement under the 50 m threshold is NOT a separation', () => {
    const near = stopFix(T0 + 330 * S, 9.0362); // ~22 m
    const { events } = rebuildTrip([...base, near], [], DEFAULT_TRIP_CONFIG);
    expect(events.some((e) => e.event_type === 'DRIVER_SEPARATED')).toBe(false);
  });

  it('clears with DRIVER_RETURNED once the phone is back within 30 m', () => {
    const far = stopFix(T0 + 330 * S, 9.0369);
    const back = stopFix(T0 + 900 * S, 9.03605); // ~5.5 m from stop point
    const { events, summary } = rebuildTrip([...base, far, back], [], DEFAULT_TRIP_CONFIG);
    expect(events.some((e) => e.event_type === 'DRIVER_RETURNED')).toBe(true);
    expect(summary.currently_separated).toBe(false);
    expect(summary.separation_incidents).toBe(1);
  });

  it('a lunch break longer than idleTimeoutS ends the trip deterministically', () => {
    // Driver walks away for 40 min; phone keeps sampling at standstill. The trip
    // auto-ENDs on event-time inactivity — same result no matter upload order.
    const cfg = { ...DEFAULT_TRIP_CONFIG, idleTimeoutS: 1800 };
    const away = [stopFix(T0 + 330 * S, 9.0369), stopFix(T0 + 2730 * S, 9.0375)];
    const { events, summary } = rebuildTrip([...base, ...away], [], cfg);
    expect(events.some((e) => e.event_type === 'DRIVER_SEPARATED')).toBe(true);
    expect(summary.final_state).toBe('ENDED');
    expect(shuffleKeepsState([...base, ...away], [], cfg)).toBe(true);
  });
});

function shuffleKeepsState(fixes: FixIn[], sensors: SensorIn[], cfg: Partial<typeof DEFAULT_TRIP_CONFIG>): boolean {
  const a = rebuildTrip(fixes, sensors, cfg);
  const b = rebuildTrip(shuffle(fixes, 99), shuffle(sensors, 3), cfg);
  return JSON.stringify(a.events) === JSON.stringify(b.events) &&
         JSON.stringify(a.summary) === JSON.stringify(b.summary);
}

describe('state machine basics', () => {
  it('single fix → TRIP_STARTED only, final state STARTED', () => {
    const { events, summary } = rebuildTrip([{ t: T0, lat: 9.03, lng: 38.74, speed: 0 }], []);
    expect(events.map((e) => e.event_type)).toEqual(['TRIP_STARTED']);
    expect(summary.final_state).toBe('STARTED');
  });

  it('STOPPED requires a sustained quiet window (60 s default)', () => {
    const quickStop = [
      ...movingRun(3, T0),
      { t: T0 + 90 * S, lat: 9.033, lng: 38.74, speed: 0 },          // quiet #1
      { t: T0 + 120 * S, lat: 9.033, lng: 38.74, speed: 0 },         // only 30 s span
      { t: T0 + 150 * S, lat: 9.0335, lng: 38.74, speed: 12 },       // moves again
    ];
    const { events } = rebuildTrip(quickStop, []);
    expect(events.some((e) => e.event_type === 'STOPPED')).toBe(false);

    const realStop = [...quickStop.slice(0, 4), { t: T0 + 150 * S, lat: 9.033, lng: 38.74, speed: 0 }];
    const ev2 = rebuildTrip(realStop, []);
    expect(ev2.events.some((e) => e.event_type === 'STOPPED')).toBe(true);
  });

  it('auto-ENDS after idleTimeoutS without transitions', () => {
    const cfg = { ...DEFAULT_TRIP_CONFIG, idleTimeoutS: 60 };
    const long = [
      { t: T0, lat: 9.03, lng: 38.74, speed: 0 },
      { t: T0 + 120_000, lat: 9.03, lng: 38.74, speed: 0 },
    ];
    const { events, summary } = rebuildTrip(long, [], cfg);
    expect(summary.final_state).toBe('ENDED');
    expect(events.some((e) => e.event_type === 'TRIP_ENDED')).toBe(true);
  });

  it('device-reported TURN dedupes the GPS-derived twin within ±20 s', () => {
    const fixes = movingRun(8, T0);
    // Force a right turn geometrically: east leg then north leg.
    const turned: FixIn[] = [
      { t: T0, lat: 9.03, lng: 38.74, speed: 14 },
      { t: T0 + 30 * S, lat: 9.03, lng: 38.745, speed: 14 },
      { t: T0 + 60 * S, lat: 9.0305, lng: 38.745, speed: 14 },
      { t: T0 + 90 * S, lat: 9.031, lng: 38.745, speed: 14 },
    ];
    const gpsOnly = rebuildTrip(turned, []);
    const withDevice = rebuildTrip(turned, [
      { t: turned[2]!.t + 5 * S, kind: 'turn', payload: { direction: 'left', delta_deg: -80 } },
    ]);
    expect(gpsOnly.summary.turn_count).toBe(1);
    expect(withDevice.summary.turn_count).toBe(1); // deduped, not double-counted
    expect(fixes.length).toBe(8);
  });
});
