/**
 * Phase 3 — deterministic boundary-crossing unit coverage WITHOUT Postgres.
 *
 * The DB-gated suite (tests/geofence_crossing.test.ts) proves the full pipeline
 * against live PostGIS. This file proves the pure transition-diff/attribution
 * core (diffTransitions / sortFixesChronologically / attributeTrip) in any CI,
 * so "boundary-crossing logic is deterministic and covered by tests" holds even
 * where no database exists (§1.8.3: event time is the only truth; arrival order
 * is meaningless).
 */

// env.ts fail-fasts at import time (crossing.ts → db/pool.ts → config/env.js).
// These are inert contract values — no connection is made for pure functions.
// NOTE: the module import below MUST stay dynamic (await import) because vitest
// hoists static imports above this env setup — same pattern as
// tests/route_cache_invalidation.test.ts.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://yet:test@127.0.0.1:1/yet_none';
process.env.JWT_SECRET ??= 'crossing-test-secret-0123456789abcdef';

import { describe, it, expect } from 'vitest';

const { diffTransitions, sortFixesChronologically, attributeTrip } =
  await import('../src/modules/geofence/crossing.js');

// Minute-offset event times: T(0)=08:00 ... T(90)=09:30 (2026-10-20 UTC).
const T = (min: number) => Date.UTC(2026, 9, 20, 8, min);

const FENCE = [{ geofence_id: 'g-1', name: 'Bole Warehouse', category: 'WAREHOUSE' }];
const VEHICLE = 'veh-1';
const DRIVER = 'drv-1';

const trip = (id: string, startMin: number, endMin: number | null) => ({
  trip_id: id,
  started_at: new Date(T(startMin)).toISOString(),
  ended_at: endMin == null ? null : new Date(T(endMin)).toISOString(),
});

const WINDOW = { fromMs: T(0), toMs: T(60) };

/** Run diffTransitions with a single fence over a fix/status sequence. */
function oneFence(
  fixes: { t: number; lat: number; lng: number }[],
  statusRow: boolean[],
  tripRows: { trip_id: string; started_at: string; ended_at: string | null }[],
  window = WINDOW,
) {
  return diffTransitions(
    { fences: FENCE, fenceIds: ['g-1'], status: [statusRow], fixes, tripRows, ...window },
    VEHICLE, DRIVER,
  );
}

const fix = (min: number, lat = 9.0 + min * 0.001, lng = 38.75) => ({ t: T(min), lat, lng });

describe('diffTransitions — ENTER/EXIT derivation', () => {
  const trips = [trip('t-A', -10, 70)]; // covers the whole window

  it('emits ENTER then EXIT in event-time order for an in-and-out drive', () => {
    const fixes = [fix(5), fix(10), fix(20), fix(30), fix(40)];
    const evs = oneFence(fixes, [false, true, true, false, false], trips);
    expect(evs.map((e) => e.event_type)).toEqual(['GEOFENCE_ENTER', 'GEOFENCE_EXIT']);
    expect(evs.map((e) => e.event_timestamp_ms)).toEqual([T(10), T(30)]);
    for (const e of evs) {
      expect(e.trip_id).toBe('t-A');
      expect(e.geofence_id).toBe('g-1');
      expect(e.geofence_name).toBe('Bole Warehouse');
      expect(e.category).toBe('WAREHOUSE');
      expect(e.vehicle_id).toBe(VEHICLE);
      expect(e.driver_id).toBe(DRIVER);
    }
    // Coordinates carried from the crossing fix itself.
    expect(evs[0]!.lat).toBeCloseTo(9.0 + 10 * 0.001);
  });

  it('stays silent on steady state (all-inside and all-outside)', () => {
    const fixes = [fix(5), fix(15), fix(25)];
    expect(oneFence(fixes, [true, true, true], trips)).toEqual([]);
    expect(oneFence(fixes, [false, false, false], trips)).toEqual([]);
  });

  it('a single fix cannot produce a transition (no previous state to diff)', () => {
    expect(oneFence([fix(10)], [true], trips)).toEqual([]);
  });

  it('replay idempotency: re-running the same window yields identical events', () => {
    const fixes = [fix(5), fix(10), fix(20)];
    const row = [false, true, true];
    const a = oneFence(fixes, row, trips);
    const b = oneFence(fixes, [...row], trips); // second replay of same batch
    expect(b).toEqual(a);
    // §1.8.3 upsert key (trip_id, event_type, event_timestamp) is stable across
    // replays — duplicate rows can never accumulate.
    const keys = (evs: typeof a) => evs.map((e) => `${e.trip_id}|${e.event_type}|${e.event_timestamp_ms}`);
    expect(keys(b).sort()).toEqual(keys(a).sort());
  });

  it('window filter: anchor fix before fromMs informs state but emits nothing', () => {
    // Anchor at T(-5) outside → ENTER at T(10) inside; EXIT at T(90) is AFTER
    // toMs=T(60) and must not be emitted this pass (a later window will catch it).
    const fixes = [fix(-5), fix(10), fix(90)];
    const evs = oneFence(fixes, [false, true, false], trips);
    expect(evs.map((e) => e.event_type)).toEqual(['GEOFENCE_ENTER']);
    expect(evs[0]!.event_timestamp_ms).toBe(T(10));
  });

  it('multiple fences each diff independently, ordered fence-major', () => {
    const fixes = [fix(10), fix(20), fix(30)];
    const fences = [
      { geofence_id: 'g-1', name: 'Zone One', category: 'WAREHOUSE' },
      { geofence_id: 'g-2', name: 'Zone Two', category: 'DEPOT' },
    ];
    const evs = diffTransitions(
      {
        fences, fenceIds: ['g-1', 'g-2'],
        status: [[false, true, true], [true, true, false]],
        fixes, tripRows: trips, ...WINDOW,
      },
      VEHICLE, DRIVER,
    );
    expect(evs.map((e) => [e.geofence_id, e.event_type])).toEqual([
      ['g-1', 'GEOFENCE_ENTER'],
      ['g-2', 'GEOFENCE_EXIT'],
    ]);
    expect(evs[1]!.category).toBe('DEPOT');
  });

  it('attribution: latest-started containing trip wins on overlap', () => {
    const overlapping = [trip('t-early', 0, 60), trip('t-late', 15, 45)];
    const fixes = [fix(10), fix(20)];
    const evs = oneFence(fixes, [false, true], overlapping);
    expect(evs.length).toBe(1);
    expect(evs[0]!.trip_id).toBe('t-late'); // contains T(20), started latest
  });

  it('attribution fallback: edge fix between trips attaches to most recent past trip', () => {
    // Trip 1 ends T(10); Trip 2 starts T(30); crossing at T(20) is in neither.
    const split = [trip('t-1', 0, 10), trip('t-2', 30, 60)];
    const fixes = [fix(15), fix(20)];
    const evs = oneFence(fixes, [false, true], split);
    expect(evs.length).toBe(1);
    expect(evs[0]!.trip_id).toBe('t-1');
  });

  it('no trip at all → no events (crossings without a trip are dropped)', () => {
    const fixes = [fix(10), fix(20)];
    expect(oneFence(fixes, [false, true], [])).toEqual([]);
  });

  it('fix BEFORE every trip start has no attribution candidate → dropped', () => {
    const later = [trip('t-later', 40, 70)];
    const fixes = [fix(5), fix(10)];
    expect(oneFence(fixes, [false, true], later)).toEqual([]);
  });

  it('out-of-order arrival produces IDENTICAL events to in-order arrival', () => {
    const tripsLocal = [trip('t-A', -10, 70)];
    const inOrder = [fix(5), fix(10), fix(20), fix(30)];
    const shuffled = [fix(30), fix(10), fix(5), fix(20)];
    // Status columns travel WITH their fixes (as evaluateCrossings builds them
    // from the SQL matrix ordered by fix_timestamp): outside→inside→inside→outside.
    const a = oneFence(inOrder, [false, true, true, false], tripsLocal);
    const b = oneFence(shuffled, [false, true, false, true], tripsLocal);
    expect(b).toEqual(a);
    expect(a.length).toBe(2);
  });

  it('input arrays are never mutated (pure function contract)', () => {
    const fixes = [fix(10), fix(20)];
    const row = [false, true];
    const fixesCopy = structuredClone(fixes);
    const rowCopy = [...row];
    diffTransitions(
      { fences: FENCE, fenceIds: ['g-1'], status: [row], fixes, tripRows: [trip('t', 0, 60)], ...WINDOW },
      VEHICLE, DRIVER,
    );
    expect(fixes).toEqual(fixesCopy);
    expect(row).toEqual(rowCopy);
  });
});

describe('sortFixesChronologically', () => {
  it('carries status-matrix columns with their fix when reordering', () => {
    const f0 = fix(30), f1 = fix(10), f2 = fix(20);
    const { fixes, status } = sortFixesChronologically(
      [f0, f1, f2],
      [[true, false, true]], // per-fence row aligned to INPUT indices
    );
    expect(fixes.map((f) => f.t)).toEqual([T(10), T(20), T(30)]);
    expect(status).toEqual([[false, true, true]]); // reordered alongside
  });

  it('returns the SAME array references when already sorted (fast path)', () => {
    const fixes = [fix(10), fix(20)];
    const status = [[false, true]];
    const out = sortFixesChronologically(fixes, status);
    expect(out.fixes).toBe(fixes);
    expect(out.status).toBe(status);
  });

  it('does not mutate inputs while sorting', () => {
    const fixes = [fix(30), fix(10)];
    const status = [[true, false]];
    sortFixesChronologically(fixes, status);
    expect(fixes[0]!.t).toBe(T(30));
    expect(status[0]).toEqual([true, false]);
  });

  it('missing status cells default to false (defensive against short rows)', () => {
    const { status } = sortFixesChronologically([fix(20), fix(10)], [[]]);
    expect(status).toEqual([[false, false]]);
  });
});

describe('attributeTrip boundary rules', () => {
  const trips = [trip('t-1', 0, 30), trip('t-2', 30, 60), trip('t-open', 70, null)];

  it('inclusive boundaries: fix exactly at trip start/end attributes to that trip', () => {
    expect(attributeTrip(trips, T(0))!.trip_id).toBe('t-1');
    // T(30) is contained in BOTH t-1 (end) and t-2 (start) → latest start wins.
    expect(attributeTrip(trips, T(30))!.trip_id).toBe('t-2');
  });

  it('open-ended (ended_at NULL) trip contains everything after its start', () => {
    expect(attributeTrip(trips, T(120))!.trip_id).toBe('t-open');
  });

  it('gap between last end and next start falls back to the earlier trip', () => {
    const closed = [trip('t-1', 0, 30), trip('t-2', 40, 60)];
    expect(attributeTrip(closed, T(35))!.trip_id).toBe('t-1');
  });

  it('fix before every trip → null', () => {
    expect(attributeTrip(trips, T(-1))).toBeNull();
  });

  it('empty trip list → null', () => {
    expect(attributeTrip([], T(10))).toBeNull();
  });

  it('accepts Date-typed started_at/ended_at as well as ISO strings', () => {
    const dateTrips = [{ trip_id: 'd-1', started_at: new Date(T(0)), ended_at: new Date(T(60)) }];
    expect(attributeTrip(dateTrips, T(10))!.trip_id).toBe('d-1');
  });
});
