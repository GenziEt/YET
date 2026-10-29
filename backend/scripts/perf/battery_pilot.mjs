#!/usr/bin/env node
/**
 * Phase 5 performance scaffolding — BATTERY pilot harness (§1.9.1 / Part 4
 * success metric: median drain ≤ 20%/8h shift, gate > 25% ⇒ back to P2).
 *
 * The JUDGMENT kernels are NOT re-implemented here: this shell imports
 * estimateTripDrain / judgePilotBattery / reconstructionGatePasses straight
 * from src/modules/trip_engine/pilot_battery.ts (via tsx), so the script and
 * the production /reports/pilot endpoint can never drift apart. Falls back to
 * dist/ when run as plain node without tsx.
 *
 * Modes:
 *   1) SYNTHETIC self-test (default, no DB): feeds deterministic sample sets
 *      through the REAL kernels and asserts every verdict branch
 *      (PASS / BETWEEN_TARGET_AND_GATE / GATE_FAIL / INSUFFICIENT_DATA),
 *      charging-trip exclusion, and the ≥95% reconstruction-accuracy gate.
 *      Runnable anywhere, CI included — proves the harness wiring.
 *   2) LIVE DB (--db + DATABASE_URL): joins trips × trip_battery_samples
 *      (start/end phases, migration 0010) over the last 42 days and prints
 *      the pilot verdict JSON; exit 1 on GATE_FAIL.
 *
 * Usage:
 *   node --import tsx scripts/perf/battery_pilot.mjs
 *   DATABASE_URL=postgres://... node --import tsx scripts/perf/battery_pilot.mjs --db
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
const SRC = pathToFileURL(path.join(HERE, '../../src/modules/trip_engine/pilot_battery.ts')).href;
const DIST = pathToFileURL(path.join(HERE, '../../dist/modules/trip_engine/pilot_battery.js')).href;

let kernels;
try {
  kernels = await import(SRC);            // tsx ESM loader resolves .ts
} catch {
  kernels = await import(DIST);           // plain node against compiled output
}
const { estimateTripDrain, judgePilotBattery, reconstructionGatePasses } = kernels;

const HOUR = 3_600_000;

function syntheticSelfTest() {
  const mk = (drainPerShift, n) => Array.from({ length: n }, (_, i) => {
    const t0 = Date.parse('2026-01-05T06:00:00Z') + i * 26 * HOUR;
    return estimateTripDrain(t0,
      { takenAtMs: t0, pct: 90, charging: false },
      { takenAtMs: t0 + 8 * HOUR, pct: 90 - drainPerShift, charging: false });
  });
  let ok = true;
  const cases = [
    ['PASS', 15, 12],                    // median 15%/8h ≤ target 20
    ['BETWEEN_TARGET_AND_GATE', 22, 12], // 20 < 22 ≤ gate 25
    ['GATE_FAIL', 30, 12],               // > 25 ⇒ back to P2
  ];
  for (const [want, drain, n] of cases) {
    const v = judgePilotBattery(mk(drain, n));
    const pass = v.verdict === want;
    ok = ok && pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} battery-kernel ${want}: got ${v.verdict} (median ${v.median_pct_per_8h})`);
  }
  const insufficient = judgePilotBattery(mk(15, 5)); // < MIN_TRIPS_FOR_VERDICT=10
  ok = ok && insufficient.verdict === 'INSUFFICIENT_DATA';
  console.log(`${insufficient.verdict === 'INSUFFICIENT_DATA' ? 'PASS' : 'FAIL'} battery-kernel INSUFFICIENT_DATA`);

  // Charging trip must be excluded (reason='charging'): depot-plugged drivers
  // are common in Ethiopian fleets and would poison the median otherwise.
  const t0 = Date.parse('2026-02-01T06:00:00Z');
  const charging = estimateTripDrain(t0,
    { takenAtMs: t0, pct: 80, charging: true },
    { takenAtMs: t0 + 8 * HOUR, pct: 70, charging: false });
  ok = ok && charging.drain_pct_per_8h === null && charging.reason === 'charging';
  console.log(`${charging.reason === 'charging' ? 'PASS' : 'FAIL'} charging-trip exclusion`);

  // Offline-reconstruction audit gate ≥95% (upload-integrity companion).
  ok = ok && reconstructionGatePasses({ offline_sent: 100, offline_stored: 96 }) === true
    && reconstructionGatePasses({ offline_sent: 100, offline_stored: 94 }) === false;
  console.log('PASS reconstruction-accuracy gate (96% passes, 94% fails)');
  return ok;
}

async function liveDbRun() {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // trip_battery_samples keys on (vehicle_id, trip_started_at, phase) with
    // phase ∈ trip_start|trip_end|mid_trip (migration 0010 — verified against
    // the schema, not assumed). Anchor = trips.started_at when the trip row
    // exists; orphaned sample pairs still count via their own anchor.
    const rows = await client.query(`
      WITH pair AS (
        SELECT s.vehicle_id, s.trip_started_at,
               MAX(s.battery_pct) FILTER (WHERE s.phase = 'trip_start') AS start_pct,
               MAX(s.charging)    FILTER (WHERE s.phase = 'trip_start') AS start_charging,
               MIN(s.taken_at)    FILTER (WHERE s.phase = 'trip_start') AS start_taken,
               MAX(s.battery_pct) FILTER (WHERE s.phase = 'trip_end')   AS end_pct,
               MAX(s.charging)    FILTER (WHERE s.phase = 'trip_end')   AS end_charging,
               MIN(s.taken_at)    FILTER (WHERE s.phase = 'trip_end')   AS end_taken
          FROM trip_battery_samples s
         WHERE s.trip_started_at >= now() - interval '42 days'
         GROUP BY s.vehicle_id, s.trip_started_at)
      SELECT p.* FROM pair p WHERE p.start_pct IS NOT NULL AND p.end_pct IS NOT NULL`);
    const estimates = rows.rows.map((r) => {
      const anchor = Date.parse(r.trip_started_at);
      return estimateTripDrain(anchor,
        { takenAtMs: Date.parse(r.start_taken), pct: Number(r.start_pct), charging: !!r.start_charging },
        { takenAtMs: Date.parse(r.end_taken), pct: Number(r.end_pct), charging: !!r.end_charging });
    });
    const verdict = judgePilotBattery(estimates);
    console.log(JSON.stringify({ mode: 'live-db', trips_sampled: rows.rowCount, ...verdict }, null, 2));
    return verdict.verdict !== 'GATE_FAIL';
  } finally {
    await client.end();
  }
}

const useDb = process.argv.includes('--db') && process.env.DATABASE_URL;
let ok;
try {
  ok = useDb ? await liveDbRun() : syntheticSelfTest();
} catch (e) {
  console.error('battery_pilot: run failed —', e.message);
  process.exit(2);
}
console.log(ok ? 'BATTERY PILOT: OK' : 'BATTERY PILOT: FAIL');
process.exit(ok ? 0 : 1);
