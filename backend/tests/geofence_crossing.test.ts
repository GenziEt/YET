/**
 * Phase 3 — Postgres-integration test for the geofence crossing evaluator.
 *
 * The pure-unit suite (tests/osm_gateway.test.ts) covers geometry validation and
 * ETA math only; the SQL surface of evaluateCrossings (envelope candidate query,
 * status-matrix CTE with unnest WITH ORDINALITY, circle ST_DWithin on geography,
 * polygon ST_Intersects, single-trip attribution) was proven load-bearing by the
 * first live-stack gate run — a parameter-type bug that no mock could catch.
 * This file closes that gap without needing HTTP/Redis/OSRM: it talks to
 * Postgres directly.
 *
 * Gated like Phase 2 discipline: skipped unless YET_TEST_DB is set.
 *   YET_TEST_DB=postgres://postgres:postgres@127.0.0.1:5432/yet npm test
 * Point it at a scratch database that has the migrations applied; the test
 * creates and drops its own rows (unique synthetic vehicle + uuid-named zones).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const DB = process.env.YET_TEST_DB;
const d = DB ? describe : describe.skip;

// Reuse the app's pool by pointing DATABASE_URL at the same scratch DB BEFORE
// importing the module under test (pool.js reads env at import time).
if (DB) process.env.DATABASE_URL = DB;

let poolX: pg.Pool; // our own connection for fixtures/cleanup
let evaluateCrossings: typeof import('../src/modules/geofence/crossing.js')['evaluateCrossings'];
let persistCrossingEvents: typeof import('../src/modules/geofence/crossing.js')['persistCrossingEvents'];
let attributeTrip: typeof import('../src/modules/geofence/crossing.js')['attributeTrip'];

const vehicleId = randomUUID();
const driverId = randomUUID();
const fenceCircle = randomUUID();
const fencePolygon = randomUUID();
// Phase 0 tenancy: geofences.fleet_id is NOT NULL (migration 0014) — fixtures
// create a scratch tenant and attach both zones to it.
const testFleetId = randomUUID();
// Far-future base so fixtures never collide with real/gate data day-partitions.
const BASE = Date.now() + 365 * 24 * 3600_000;

/** 'YYYY-MM' → 'YYYY-MM' of the following month (for partition upper bounds). */
function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // month index is 0-based → this is next month's 1st
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

d('crossing evaluator (Postgres integration)', () => {
  beforeAll(async () => {
    poolX = new pg.Pool({ connectionString: DB, max: 2 });
    await poolX.query(`SELECT 1`); // fail fast if unreachable
    const mod = await import('../src/modules/geofence/crossing.js');
    evaluateCrossings = mod.evaluateCrossings;
    persistCrossingEvents = mod.persistCrossingEvents;
    attributeTrip = mod.attributeTrip;

    // Scratch tenant (FK target for geofences.fleet_id post-0014).
    await poolX.query(
      `INSERT INTO fleets (id, name, status) VALUES ($1,$2,'ACTIVE')
       ON CONFLICT (id) DO NOTHING`, [testFleetId, `itest-fleet-${testFleetId.slice(0, 8)}`]);

    // Vehicle row (FK target) + one trip covering the whole corridor.
    // NOTE: vehicles PK column is `id` (not vehicle_id); trips.state is the enum
    // column; polygon geom must satisfy chk_circle_shape (ST_MultiPolygon).
    await poolX.query(
      `INSERT INTO vehicles (id, plate_number, fleet_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`, [vehicleId, `T-${vehicleId.slice(0, 8)}`, testFleetId]);
    // Driver row: trips.driver_id has an FK to users(id). Post-0013 the
    // user_fleet_membership trigger REQUIRES a non-null fleet_id for DRIVER
    // role — attach the driver to the same scratch tenant as the fixtures.
    await poolX.query(
      `INSERT INTO users (id, role, full_name, password_hash, locale, is_active, fleet_id)
       VALUES ($1,'DRIVER','Integration Test Driver','not-a-hash','en',true,$2)
       ON CONFLICT (id) DO NOTHING`, [driverId, testFleetId]);
    await poolX.query(
      `INSERT INTO trips (trip_id, vehicle_id, driver_id, started_at, ended_at, last_activity_at, state)
       VALUES ($1,$2,$3,$4,$5,$4,'MOVING')
       ON CONFLICT (trip_id) DO NOTHING`,
      [randomUUID(), vehicleId, driverId,
       new Date(BASE - 60_000).toISOString(), new Date(BASE + 30 * 60_000).toISOString()]);

    // Circle zone: center east of start, radius 350 m. Point stays POINT after
    // geography→geometry round-trip, satisfying the CIRCLE branch of the check.
    await poolX.query(
      `INSERT INTO geofences (geofence_id, name, kind, category, active, geom, radius_m, center_lat, center_lng, fleet_id)
       VALUES ($1,'itest-circle','CIRCLE','WAREHOUSE',true,
               ST_SetSRID(ST_MakePoint($3,$2),4326)::geography::geometry, 350, $2, $3, $4)`,
      [fenceCircle, 9.0305, 38.7469, testFleetId]);
    // Polygon zone: square ~300 m around (9.0325, 38.7469) — straddles the
    // corridor so the same drive crosses BOTH kinds (circle ENTER/EXIT at the
    // edge fix, polygon ENTER/EXIT one step later).
    await poolX.query(
      `INSERT INTO geofences (geofence_id, name, kind, category, active, geom, fleet_id)
       VALUES ($1,'itest-polygon','POLYGON','CUSTOMER_SITE',true,
               ST_Multi(ST_SetSRID(ST_MakeEnvelope($2,$3,$4,$5),4326)), $6)`,
      [fencePolygon, 38.7454, 9.0311, 38.7484, 9.0339, testFleetId]);

    // Corridor fixes: start outside both zones, drive ENE into circle then out,
    // one fix inside the polygon on the way (mixed ENTER/EXIT across two kinds).
    // NOTE: location_fixes.fix_id is `generated always as identity` — never
    // supply it; and a far-future BASE requires the monthly partitions to exist.
    const stepMin = 30_000; // 30 s cadence
    const mk = (m: number, lat: number, lng: number, speed: number) => ({
      fix_timestamp: new Date(BASE + m * stepMin).toISOString(),
      lat, lng, speed_mps: speed, accuracy_m: 8, provider: 'gps',
    });
    const fixes = [
      mk(0, 9.0315, 38.7325, 11),   // far outside (south of both zones)
      mk(4, 9.0315, 38.7395, 11),
      mk(8, 9.0315, 38.7465, 11),   // just inside circle edge (ENTER)
      mk(12, 9.0315, 38.7475, 11),  // inside circle
      mk(16, 9.0315, 38.7525, 11),  // inside circle AND inside polygon
      mk(20, 9.0315, 38.7565, 11),  // outside circle, outside polygon (EXITS)
      mk(24, 9.0315, 38.7605, 0),
    ];
    // Ensure the monthly partitions covering BASE exist (migration 0002 creates
    // a rolling window; a far-future BASE may fall outside it).
    for (const t of [BASE - 60_000, BASE + 30 * 60_000]) {
      const dte = new Date(t);
      const ym = `${dte.getUTCFullYear()}-${String(dte.getUTCMonth() + 1).padStart(2, '0')}`;
      await poolX.query(
        `CREATE TABLE IF NOT EXISTS location_fixes_${ym.replace('-', '')}
           PARTITION OF location_fixes FOR VALUES FROM ('${ym}-01') TO ('${nextMonth(ym)}-01')`);
    }

    for (const f of fixes) {
      await poolX.query(
        `INSERT INTO location_fixes (batch_id, vehicle_id, driver_id, fix_timestamp, lat, lng,
                                     speed_mps, accuracy_m, provider, geom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                 ST_SetSRID(ST_MakePoint($6,$5),4326))`,
        [randomUUID(), vehicleId, driverId, f.fix_timestamp, f.lat, f.lng,
         f.speed_mps, f.accuracy_m, f.provider]);
    }
  }, 30_000);

  afterAll(async () => {
    if (!poolX) return;
    await poolX.query(`DELETE FROM trip_events WHERE vehicle_id=$1`, [vehicleId]).catch(() => {});
    await poolX.query(`DELETE FROM location_fixes WHERE vehicle_id=$1`, [vehicleId]).catch(() => {});
    await poolX.query(`DELETE FROM trips WHERE vehicle_id=$1`, [vehicleId]).catch(() => {});
    await poolX.query(`DELETE FROM geofences WHERE geofence_id IN ($1,$2)`, [fenceCircle, fencePolygon]).catch(() => {});
    await poolX.query(`DELETE FROM fleets WHERE id=$1`, [testFleetId]).catch(() => {});
    await poolX.query(`DELETE FROM vehicles WHERE id=$1`, [vehicleId]).catch(() => {});
    await poolX.end();
  });

  it('emits exactly one ENTER and one EXIT per zone over the corridor', async () => {
    const events = await evaluateCrossings(vehicleId, driverId, BASE - 60_000, BASE + 25 * 30_000);
    const byZone = (id: string) => events.filter((e) => e.geofence_id === id);
    const circle = byZone(fenceCircle);
    const poly = byZone(fencePolygon);
    expect(circle.filter((e) => e.event_type === 'GEOFENCE_ENTER')).toHaveLength(1);
    expect(circle.filter((e) => e.event_type === 'GEOFENCE_EXIT')).toHaveLength(1);
    expect(poly.filter((e) => e.event_type === 'GEOFENCE_ENTER')).toHaveLength(1);
    expect(poly.filter((e) => e.event_type === 'GEOFENCE_EXIT')).toHaveLength(1);
    // Event ordering: circle ENTER precedes circle EXIT (event-time semantics).
    const cEnter = circle.find((e) => e.event_type === 'GEOFENCE_ENTER')!;
    const cExit = circle.find((e) => e.event_type === 'GEOFENCE_EXIT')!;
    expect(cEnter.event_timestamp_ms).toBeLessThan(cExit.event_timestamp_ms);
    // Every event carries a fix position inside/outside the boundary respectively.
    expect(cEnter.lat).toBeCloseTo(9.0315, 4);
  });

  it('persist + re-evaluate is idempotent (no duplicate rows under the §1.8.3 key)', async () => {
    const win = { from: BASE - 60_000, to: BASE + 25 * 30_000 };
    const ev1 = await evaluateCrossings(vehicleId, driverId, win.from, win.to);
    await persistCrossingEvents(ev1);
    const ev2 = await evaluateCrossings(vehicleId, driverId, win.from, win.to);
    await persistCrossingEvents(ev2); // replay → upsert, must not multiply
    const { rows: dup } = await poolX.query(
      `SELECT event_type, event_timestamp FROM trip_events
        WHERE vehicle_id=$1 AND event_type IN ('GEOFENCE_ENTER','GEOFENCE_EXIT')
        GROUP BY 1,2 HAVING count(*) > 1`, [vehicleId]);
    expect(dup.length).toBe(0);
    expect(ev2.map((e) => `${e.event_type}@${e.event_timestamp_ms}`).sort())
      .toEqual(ev1.map((e) => `${e.event_type}@${e.event_timestamp_ms}`).sort());
  });

  it('window clipping: a sub-window that excludes the crossing emits nothing for it', async () => {
    // Only fixes well INSIDE the circle (between ENTER and EXIT moments).
    const events = await evaluateCrossings(vehicleId, driverId, BASE + 12 * 30_000, BASE + 13 * 30_000);
    expect(events.filter((e) => e.geofence_id === fenceCircle)).toHaveLength(0);
  });

  it('attributeTrip picks the latest-started containing trip and falls back sensibly', () => {
    const t = (id: string, s: number, e: number | null) =>
      ({ trip_id: id, started_at: new Date(s).toISOString(), ended_at: e ? new Date(e).toISOString() : null });
    const trips = [t('A', 1000, 5000), t('B', 3000, 8000)]; // overlap 3000..5000
    expect(attributeTrip(trips, 4000)!.trip_id).toBe('B'); // latest-started containing wins
    expect(attributeTrip(trips, 7000)!.trip_id).toBe('B'); // only B contains
    expect(attributeTrip(trips, 9000)!.trip_id).toBe('B'); // none contains → latest started ≤ t
    expect(attributeTrip([], 9000)).toBeNull();
  });
});
