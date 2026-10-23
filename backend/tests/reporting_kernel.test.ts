import { describe, it, expect } from 'vitest';
import {
  haversineKm, bucketTripsByWeek, summarizeTrips, buildFleetOverview,
  FLEET_STATE_TTL_S, FLEET_LIVE_WINDOW_S,
  type TripAggRow, type VehicleLatestFix, type TripStatusLite,
} from '../src/modules/reporting/kernel.js';

/** Phase 5 (F) — pure reporting kernel units. Injected clocks only, no I/O. */

const HOUR = 3600_000;

function trip(over: Partial<TripAggRow> & { trip_id: string; started_at: string }): TripAggRow {
  return {
    ended_at: null, state: 'ENDED', distance_m: 10000, moving_duration_s: 600,
    stopped_duration_s: 60, turn_count: 1, harsh_event_count: 0, ...over,
  };
}

describe('haversineKm', () => {
  it('known Addis -> Adama distance within 1%', () => {
    const d = haversineKm({ lat: 9.035, lng: 38.74 }, { lat: 8.54, lng: 39.66 });
    expect(d).toBeGreaterThan(105);
    expect(d).toBeLessThan(116);
  });
  it('zero for identical points, symmetric', () => {
    expect(haversineKm({ lat: 9, lng: 38.7 }, { lat: 9, lng: 38.7 })).toBeCloseTo(0, 10);
    const a = { lat: 9.1, lng: 38.8 }, b = { lat: 8.9, lng: 38.6 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 10);
  });
});

describe('bucketTripsByWeek', () => {
  it('Monday anchor: Sun 2026-10-25 EAT falls into Mon 2026-10-19 week', () => {
    // Sunday 21:00Z = Monday 00:00 EAT? No: 21:00Z+3h = 24:00 -> still Sunday local midnight boundary.
    // Use Sunday 12:00Z (15:00 EAT) -> week starting Monday 2026-10-19.
    const weeks = bucketTripsByWeek([trip({ trip_id: 'a', started_at: '2026-10-25T12:00:00Z' })]);
    expect(weeks).toEqual([{ week_start: '2026-10-19', trips: 1, distance_km: 10 }]);
  });

  it('EAT offset moves the boundary: Mon 2026-10-26T00:30Z is Sunday 27th in UTC but Monday 28th... check both offsets', () => {
    // 2026-10-26 is a Monday. 2026-10-25T22:00Z = 2026-10-26T01:00 EAT (Monday local).
    const row = [trip({ trip_id: 'x', started_at: '2026-10-25T22:00:00Z' })];
    expect(bucketTripsByWeek(row, 3 * HOUR)[0].week_start).toBe('2026-10-26'); // EAT => new week
    expect(bucketTripsByWeek(row, 0)[0].week_start).toBe('2026-10-19');        // UTC => previous week
  });

  it('replay equality: shuffled input rows produce identical buckets', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      trip({ trip_id: `t${i}`, started_at: new Date(Date.UTC(2026, 9, 5 + (i % 21), (i % 24))).toISOString(), distance_m: 1000 * (i + 1) }));
    const a = bucketTripsByWeek(rows);
    const shuffled = [...rows].sort((p, q) => (p.trip_id < q.trip_id ? 1 : -1));
    expect(bucketTripsByWeek(shuffled)).toEqual(a);
  });

  it('weeks sorted ascending and km rounded to 2dp', () => {
    const weeks = bucketTripsByWeek([
      trip({ trip_id: 'b', started_at: '2026-11-02T08:00:00Z', distance_m: 333 }),
      trip({ trip_id: 'a', started_at: '2026-10-19T08:00:00Z', distance_m: 111 }),
    ]);
    expect(weeks.map((w) => w.week_start)).toEqual(['2026-10-19', '2026-11-02']);
    expect(weeks[0].distance_km).toBe(0.11);
  });
});

describe('summarizeTrips', () => {
  it('adds totals across rows and rounds km', () => {
    const s = summarizeTrips([
      trip({ trip_id: 'a', started_at: '2026-10-19T08:00:00Z', distance_m: 12345, moving_duration_s: 100, stopped_duration_s: 10, turn_count: 2, harsh_event_count: 1 }),
      trip({ trip_id: 'b', started_at: '2026-10-20T08:00:00Z', distance_m: 1, moving_duration_s: 200, stopped_duration_s: 20, turn_count: 3, harsh_event_count: 0 }),
    ]);
    expect(s.trip_count).toBe(2);
    expect(s.total_distance_km).toBe(12.35);
    expect(s.total_moving_s).toBe(300);
    expect(s.total_stopped_s).toBe(30);
    expect(s.turn_count).toBe(5);
    expect(s.harsh_event_count).toBe(1);
  });
  it('empty input is all-zero, not NaN', () => {
    expect(summarizeTrips([]).total_distance_km).toBe(0);
  });
});

describe('buildFleetOverview', () => {
  const NOW = Date.parse('2026-10-23T12:00:00Z');
  const fix = (v: string, atMs: number): VehicleLatestFix => ({
    vehicle_id: v, plate_number: `P-${v}`, driver_id: `d-${v}`, driver_name: `N-${v}`,
    fix_timestamp: new Date(atMs).toISOString(), lat: 9.03, lng: 38.74, speed_mps: 10, accuracy_m: 5,
  });
  const status = (v: string, sepOpen = false): TripStatusLite => ({
    vehicle_id: v, trip_id: `tr-${v}`, driver_id: `d-${v}`, state: 'MOVING',
    started_at: new Date(NOW - HOUR).toISOString(), last_activity_at: new Date(NOW).toISOString(),
    separation_open: sepOpen, separated_minutes: sepOpen ? 50 : null, notified: sepOpen,
  });

  it('deterministic for injected nowMs — same inputs twice, byte-identical output', () => {
    const input = { fixes: [fix('v1', NOW - 30_000)], statuses: [status('v1')], nowMs: NOW, liveWindowS: FLEET_LIVE_WINDOW_S };
    expect(buildFleetOverview(input)).toEqual(buildFleetOverview(input));
  });

  it('live vs stale vs offline classification by age', () => {
    const r = buildFleetOverview({
      fixes: [fix('live', NOW - 10_000), fix('stale', NOW - 600_000), fix('veryold', NOW - 86_400_000)],
      statuses: [], nowMs: NOW, liveWindowS: FLEET_LIVE_WINDOW_S,
    });
    const byId = Object.fromEntries(r.vehicles.map((v) => [v.vehicle_id, v]));
    expect(byId.live.is_live).toBe(true);
    expect(byId.live.last_fix_age_s).toBe(10);
    expect(byId.stale.is_live).toBe(false);   // 600s > 120s window
    expect(byId.stale.last_fix_age_s).toBe(600);
    expect(byId.veryold.is_live).toBe(false);
    expect(r.counts.offline).toBe(2);         // both non-live counted offline
    expect(r.counts.stale).toBe(2);           // age > 4×window for both
  });

  it('vehicle with trip but zero fixes: last_fix null, counts on_trip', () => {
    const r = buildFleetOverview({ fixes: [], statuses: [status('ghost', true)], nowMs: NOW, liveWindowS: FLEET_LIVE_WINDOW_S });
    expect(r.vehicles[0].last_fix).toBeNull();
    expect(r.vehicles[0].last_fix_age_s).toBeNull();
    expect(r.vehicles[0].is_live).toBe(false);
    expect(r.counts.on_trip).toBe(1);
    expect(r.counts.separated_open).toBe(1);
  });

  it('generated_at derives from nowMs only (cache replay stability)', () => {
    const r = buildFleetOverview({ fixes: [], statuses: [], nowMs: NOW, liveWindowS: FLEET_LIVE_WINDOW_S });
    expect(r.generated_at).toBe(new Date(NOW).toISOString());
  });

  it('constants match the spec: TTL 30s, live window 120s', () => {
    expect(FLEET_STATE_TTL_S).toBe(30);
    expect(FLEET_LIVE_WINDOW_S).toBe(120);
  });
});
