import { describe, it, expect } from 'vitest';
import {
  estimateTripDrain, judgePilotBattery, median,
  reconstructionAccuracy, reconstructionGatePasses,
  MIN_VALID_TRIP_S, MIN_TRIPS_FOR_VERDICT,
  BATTERY_TARGET_PCT_PER_SHIFT, BATTERY_GATE_MAX_PCT_PER_SHIFT,
  RECONSTRUCTION_MIN_ACCURACY, SHIFT_HOURS,
  type DrainEstimate, type BatterySampleIn,
} from '../src/modules/trip_engine/pilot_battery.js';

/**
 * Phase 4 gate tests — PILOT BATTERY KERNEL (pure functions, no DB).
 *
 * The blueprint's Phase 4 gate: "If median battery drain exceeds 25% per 8-hour
 * shift, return to Phase 2 and tune sensor gating thresholds before proceeding",
 * with Part 4 success metric "median ≤ 20% per 8-hour shift". These tests pin
 * the arithmetic so the integration script, pilot dashboard, and runbook all
 * read the SAME constants and boundary semantics:
 *   - drain math is duration-normalized to /8h (a 3h trip and a 9h trip are
 *     comparable);
 *   - charging samples and negative deltas (clock skew / OS rounding) are
 *     EXCLUDED from the median rather than silently clamped;
 *   - verdict requires MIN_TRIPS_FOR_VERDICT usable trips — the pilot cannot
 *     "pass" on three lucky shifts;
 *   - offline reconstruction accuracy gate is ≥ 95% (§Phase 4 audit).
 */

const T0 = Date.parse('2026-10-20T06:00:00Z');
const S = 1000;

function sample(pct: number, atMs: number, charging = false): BatterySampleIn {
  return { takenAtMs: atMs, pct, charging };
}

describe('estimateTripDrain — drain math', () => {
  it('normalizes raw delta to percent-per-8h-shift', () => {
    // 6-hour trip, 12% drained ⇒ 16%/8h (under the 20% target).
    const e = estimateTripDrain(T0, sample(88, T0), sample(76, T0 + 6 * 3600 * S));
    expect(e.raw_drain_pct).toBe(12);
    expect(e.drain_pct_per_8h).toBe(16);
    expect(e.duration_s).toBe(6 * 3600);
    expect(e.reason).toBeUndefined();
  });

  it('is event-time based: identical inputs ⇒ identical estimate (§1.8.3)', () => {
    const a = estimateTripDrain(T0, sample(90, T0), sample(70, T0 + 4 * 3600 * S));
    const b = estimateTripDrain(T0, sample(90, T0), sample(70, T0 + 4 * 3600 * S));
    expect(a).toEqual(b); // replayed offline batch produces the same numbers
  });

  it('exactly hits the 20%/8h target at the boundary', () => {
    // 8h shift, 20% drained ⇒ exactly 20/8h.
    const e = estimateTripDrain(T0, sample(80, T0), sample(60, T0 + SHIFT_HOURS * 3600 * S));
    expect(e.drain_pct_per_8h).toBe(BATTERY_TARGET_PCT_PER_SHIFT);
  });

  it('drops missing start or end samples', () => {
    expect(estimateTripDrain(T0, null, null).reason).toBe('insufficient_samples');
    expect(estimateTripDrain(T0, sample(80, T0), null).drain_pct_per_8h).toBeNull();
    expect(estimateTripDrain(T0, null, sample(70, T0 + 3600 * S)).drain_pct_per_8h).toBeNull();
  });

  it('excludes charging trips (depot charger poisons the math)', () => {
    const startCharging = estimateTripDrain(T0, sample(50, T0, true), sample(70, T0 + 2 * 3600 * S));
    expect(startCharging.reason).toBe('charging');
    expect(startCharging.drain_pct_per_8h).toBeNull();
    const endCharging = estimateTripDrain(T0, sample(70, T0), sample(50, T0 + 2 * 3600 * S, true));
    expect(endCharging.reason).toBe('charging');
  });

  it('reports negative drain but never feeds it into /8h stats', () => {
    // Driver plugged in mid-trip unnoticed: end > start ⇒ raw negative, excluded.
    const e = estimateTripDrain(T0, sample(60, T0), sample(65, T0 + 3 * 3600 * S));
    expect(e.raw_drain_pct).toBe(-5);
    expect(e.reason).toBe('negative_drain');
    expect(e.drain_pct_per_8h).toBeNull();
  });

  it('refuses to extrapolate absurd numbers from tiny trips', () => {
    // 2-minute trip losing 1% would "measure" 40%/8h — floor drops it instead.
    const e = estimateTripDrain(T0, sample(80, T0), sample(79, T0 + 120 * S));
    expect(e.duration_s).toBeLessThan(MIN_VALID_TRIP_S);
    expect(e.drain_pct_per_8h).toBeNull();
    expect(e.reason).toBe('insufficient_samples');
    // A quarter-hour trip IS admissible.
    const ok = estimateTripDrain(T0, sample(80, T0), sample(79, T0 + MIN_VALID_TRIP_S * S));
    expect(ok.drain_pct_per_8h).not.toBeNull();
  });
});

describe('median', () => {
  it('handles odd/even/empty without mutating input', () => {
    const vals = [30, 10, 20];
    expect(median(vals)).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([])).toBeNull();
    expect(vals).toEqual([30, 10, 20]);
  });
});

/** Build N synthetic usable estimates with given /8h medians. */
function usableTrips(perShift: number[]): DrainEstimate[] {
  return perShift.map((v, i) => ({
    trip_started_at: new Date(T0 + i * 3600 * S).toISOString(),
    duration_s: 4 * 3600,
    raw_drain_pct: v / 2, // 4h trip ⇒ half of /8h figure
    drain_pct_per_8h: v,
  }));
}

describe('judgePilotBattery — gate verdicts', () => {
  it('INSUFFICIENT_DATA below the minimum trip count', () => {
    const v = judgePilotBattery(usableTrips([10, 12, 15])); // 3 < 10
    expect(v.verdict).toBe('INSUFFICIENT_DATA');
    expect(v.trips_measured).toBe(3);
    expect(v.gate_failed).toBe(false); // "not enough data" must not read as failure
    expect(judgePilotBattery([]).verdict).toBe('INSUFFICIENT_DATA');
  });

  it('PASS when median ≤ 20%/8h', () => {
    const v = judgePilotBattery(usableTrips([12, 14, 15, 16, 18, 19, 20, 10, 11, 13]));
    // Even count ⇒ median = mean of the two central values (sorted: 10,11,12,13,14,15,16,18,19,20)
    expect(v.median_pct_per_8h).toBeCloseTo((14 + 15) / 2, 5);
    expect(v.verdict).toBe('PASS');
    expect(v.target_met).toBe(true);
    expect(v.gate_failed).toBe(false);
  });

  it('boundary: median exactly 20 still PASSES (≤ target)', () => {
    const exact = [...Array(9).fill(18), ...Array(11).fill(20)]; // sorted median = 20
    const v = judgePilotBattery(usableTrips(exact));
    expect(v.median_pct_per_8h).toBe(20);
    expect(v.verdict).toBe('PASS');
  });

  it('BETWEEN_TARGET_AND_GATE when 20 < median ≤ 25', () => {
    const v = judgePilotBattery(usableTrips([21, 22, 23, 24, 25, 21, 22, 23, 24, 25]));
    expect(v.median_pct_per_8h).toBe(23);
    expect(v.verdict).toBe('BETWEEN_TARGET_AND_GATE');
    expect(v.target_met).toBe(false);
    expect(v.gate_failed).toBe(false); // does NOT trigger back-to-Phase-2 yet
  });

  it('GATE_FAIL when median > 25%/8h — blueprint sends us back to Phase 2', () => {
    const v = judgePilotBattery(usableTrips([26, 27, 28, 29, 30, 26, 27, 28, 29, 30]));
    expect(v.median_pct_per_8h).toBe(28);
    expect(v.verdict).toBe('GATE_FAIL');
    expect(v.gate_failed).toBe(true);
    expect(v.target_met).toBe(false);
    // Boundary semantics: median 25.0 passes the gate, 25.1 fails it.
    expect(judgePilotBattery(usableTrips([...Array(9).fill(25), 25.1, 25.1, 25.1]))
      .gate_failed).toBe(false); // median still 25
    expect(judgePilotBattery(usableTrips(Array(12).fill(25.1)))
      .gate_failed).toBe(true);
  });

  it('excluded trips (null /8h) never enter the median', () => {
    const mixed: DrainEstimate[] = [
      ...usableTrips([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]),
      { trip_started_at: new Date().toISOString(), duration_s: 0, raw_drain_pct: null,
        drain_pct_per_8h: null, reason: 'charging' },
      { trip_started_at: new Date().toISOString(), duration_s: 0, raw_drain_pct: -5,
        drain_pct_per_8h: null, reason: 'negative_drain' },
    ];
    const v = judgePilotBattery(mixed);
    expect(v.trips_measured).toBe(10); // 12 rows, only 10 usable
    expect(v.median_pct_per_8h).toBeCloseTo(19.5, 1);
    expect(v.verdict).toBe('PASS');
  });

  it('computes p90 over usable estimates only', () => {
    // Kernel p90 = nearest-rank on sorted usable values: ceil(0.9*n)-1 index.
    // n=10 ⇒ index 8; with a single hot truck at the top, rank-9 is still 10 —
    // one outlier must not fail the fleet. Add three hot trucks so p90 catches them.
    const v = judgePilotBattery(usableTrips([10, 10, 10, 10, 10, 10, 10, 40, 40, 40]));
    expect(v.p90_pct_per_8h).toBe(40);
    expect(v.median_pct_per_8h).toBe(10); // one hot truck doesn't fail the fleet
    expect(v.verdict).toBe('PASS');
  });

  it('constants match the blueprint numbers (Part 4 / Phase 4 gate)', () => {
    expect(SHIFT_HOURS).toBe(8);
    expect(BATTERY_TARGET_PCT_PER_SHIFT).toBe(20);
    expect(BATTERY_GATE_MAX_PCT_PER_SHIFT).toBe(25);
    expect(RECONSTRUCTION_MIN_ACCURACY).toBe(0.95);
    expect(MIN_TRIPS_FOR_VERDICT).toBeGreaterThanOrEqual(10);
  });
});

describe('reconstruction audit (§Phase 4 gate: ≥95%)', () => {
  it('accuracy = stored/sent over offline periods', () => {
    expect(reconstructionAccuracy({ offline_sent: 100, offline_stored: 100 })).toBe(1);
    expect(reconstructionAccuracy({ offline_sent: 200, offline_stored: 191 })).toBeCloseTo(0.955, 3);
  });

  it('vacuously passes when nothing was collected offline', () => {
    expect(reconstructionAccuracy({ offline_sent: 0, offline_stored: 0 })).toBe(1);
    expect(reconstructionGatePasses({ offline_sent: 0, offline_stored: 0 })).toBe(true);
  });

  it('boundary: 95% passes, 94.9% fails', () => {
    expect(reconstructionGatePasses({ offline_sent: 100, offline_stored: 95 })).toBe(true);
    expect(reconstructionGatePasses({ offline_sent: 1000, offline_stored: 949 })).toBe(false);
  });

  it('reports ratios honestly even if server stored extra (dedupe sentinel)', () => {
    // Stored > sent would mean duplicate rows slipped past §1.8.2 idempotency;
    // the pilot dashboard shows raw counts so ops can spot the anomaly.
    const acc = reconstructionAccuracy({ offline_sent: 100, offline_stored: 105 });
    expect(acc).toBeGreaterThan(1);
  });
});
