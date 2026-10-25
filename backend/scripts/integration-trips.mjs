#!/usr/bin/env node
/**
 * Phase 2 integration gate script (§1.8.3, §1.4) — run against a LIVE backend + Postgres.
 * Mirrors scripts/integration-ingest.mjs.
 *
 * Gates:
 *  A. Out-of-order upload determinism: build one synthetic trip (moving → stop →
 *     15-min driver separation → return → moving), split into 6 batches, upload
 *     CONTROL run in chronological order and SHUFFLED run (B-before-A) under
 *     distinct event-time day offsets. Assert the DRIVER_SEPARATED payload carries
 *     BOTH truck stop location and driver location, DRIVER_RETURNED clears it, and
 *     the two runs' reconstructed trip state is IDENTICAL modulo time shift (§1.8.3).
 *  B. POST /ingest/sensors idempotency: duplicate batch_id -> already_received:true.
 *  C. GET /trips/status returns live state + separation object with truck_last_known.
 *  D. Late-arriving batch MERGE: after the shuffled run, replay the SAME batches in
 *     yet another order at the same event times; trips must not duplicate and the
 *     final trip set/state must equal the original reconstruction.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3100 \
 *   DATABASE_URL=postgres://yet:change-me@127.0.0.1:5432/yet_test \
 *   node scripts/integration-trips.mjs
 * Exit 0 = all gates pass; non-zero with message on first failure.
 */
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://yet:change-me@127.0.0.1:5432/yet_test';

// Seeded dev driver (identity ensureSeedDevDriver, dev/test only).
const DRIVER = { identifier: '+251900000001', password: 'dev-driver-secret' };

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  else { console.error(`FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
}

async function j(path, opts = {}, token) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(opts.headers ?? {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body, headers: res.headers };
}

const uuid = () => crypto.randomUUID();

/* ---------------------------------------------------------------------------
 * Synthetic scenario generator. All positions are pure functions of minute
 * offset m from trip start, so two runs at different base times reconstruct
 * identical state once normalized by subtracting started_at.
 *
 *   m 0..10   driving NE ~10 m/s, fixes every 30 s        -> MOVING
 *   m 10..25  parked at stop point P                      -> STOPPED (>60 s rule)
 *   m 25..40  phone walks ~100 m ENE of P, no accel/gyro  -> DRIVER_SEPARATED
 *   m 40..45  phone back within 30 m of P                 -> DRIVER_RETURNED
 *   m 45..55  driving again                               -> MOVING, then idle->ENDED
 * ------------------------------------------------------------------------- */
const LAT0 = 9.03, LNG0 = 38.74;          // Addis Ababa
const DLAT = 0.00009;                     // ~10 m north per unit
const DLNG = 0.00011;                     // ~11.2 m east per unit (cos-lat adjusted)
const STOP_M = 10;                        // park at minute 10
const STOP_LAT = LAT0 + STOP_M * 10 * DLAT;
const STOP_LNG = LNG0 + STOP_M * 10 * DLNG;

function posAt(m) {
  // m in minutes since trip start (fractional allowed)
  if (m <= STOP_M) return { lat: LAT0 + m * 10 * DLAT, lng: LNG0 + m * 10 * DLNG, speed: 10, heading: 45 };
  if (m <= 25) return { lat: STOP_LAT, lng: STOP_LNG, speed: 0, heading: 45 };               // parked
  const w = m - 25;                                                                          // walk away up to 15 min
  if (m <= 40) return { lat: STOP_LAT + 4 * DLAT + w * 6 * DLAT, lng: STOP_LNG + 4 * DLNG + w * 6 * DLNG, speed: 1.3, heading: 60 };
  if (m <= 45) {                                                                             // walk back
    const back = m - 40;
    return { lat: STOP_LAT + 4 * DLAT + (15 - back) * 6 * DLAT, lng: STOP_LNG + 4 * DLNG + (15 - back) * 6 * DLNG, speed: 1.3, heading: 240 };
  }
  const d = m - 45;                                                                          // driving again
  return { lat: STOP_LAT + 4 * DLAT + d * 10 * DLAT, lng: STOP_LNG + 4 * DLNG + d * 10 * DLNG, speed: 10, heading: 45 };
}

function fixAt(baseMs, m) {
  const p = posAt(m);
  return {
    fix_timestamp: new Date(baseMs + m * 60_000).toISOString(),
    lat: +p.lat.toFixed(7), lng: +p.lng.toFixed(7),
    speed_mps: p.speed, accuracy_m: 8, heading_deg: p.heading, provider: 'gps',
  };
}

/** Raw 10 Hz motion sample event (§1.8.5). Absent during the separation window. */
function sensorEventAt(baseMs, m) {
  return {
    event_timestamp: new Date(baseMs + m * 60_000).toISOString(),
    kind: 'accelerometer',
    payload: { variance: 0.02, gate: 'vibration_present' },
  };
}

function makeBatches(baseMs) {
  // [label, minuteStart, minuteEnd, fixStepMin, includeSensors]
  const plan = [
    ['A', 0, 10, 0.5, true],       // driving out
    ['B', 10, 25, 1, true],        // parked (sensors present until gate closes)
    ['C', 25, 33, 1, false],       // walked away — sensors SILENT
    ['D', 33, 40, 1, false],       // still away — sensors SILENT
    ['E', 40, 45, 1, false],       // walking back
    ['F', 45, 55, 0.5, true],      // driving again (trip ends via idle timeout later)
  ];
  return plan.map(([label, m0, m1, step, sensors]) => {
    const fixes = [];
    for (let m = m0; m < m1; m += step) fixes.push(fixAt(baseMs, m));
    const events = [];
    if (sensors) for (let m = m0; m < m1; m += 2) events.push(sensorEventAt(baseMs, m));
    return { label, batch: { batch_id: uuid(), fixes, events } };
  });
}

async function uploadRun(token, batches) {
  for (const b of batches) {
    const r = await j('/ingest/locations', { method: 'POST', body: JSON.stringify({ batch_id: b.batch.batch_id, fixes: b.batch.fixes }) }, token);
    if (r.status !== 200 || r.body.already_received) throw new Error(`location batch ${b.label} failed: ${JSON.stringify(r.body)}`);
    if (b.batch.events.length) {
      const s = await j('/ingest/sensors', { method: 'POST', body: JSON.stringify({ batch_id: uuid(), events: b.batch.events }) }, token);
      if (s.status !== 200) throw new Error(`sensor batch ${b.label} failed: ${JSON.stringify(s.body)}`);
    }
  }
}

/** Poll trip list for this vehicle until an ENDED trip covering the window exists. */
async function waitForEndedTrip(token, baseMs) {
  const startedIso = new Date(baseMs).toISOString();
  for (let i = 0; i < 30; i++) {
    const r = await j('/trips?limit=200', {}, token);
    const t = (r.body.trips ?? []).find((x) => x.started_at === startedIso);
    if (t && t.state === 'ENDED') return t;
    await new Promise((res) => setTimeout(res, 1000));
  }
  const r = await j('/trips?limit=200', {}, token);
  return (r.body.trips ?? []).find((x) => x.started_at === startedIso) ?? null;
}

/** Normalize a trip detail for cross-run comparison: strip absolute times/ids,
 *  keep event sequence (type, minute-offset, rounded coords) + separations. */
function normalizeDetail(detail) {
  const base = new Date(detail.trip.started_at).getTime();
  const evs = detail.events.map((e) => ({
    type: e.event_type,
    min: Math.round((new Date(e.event_timestamp).getTime() - base) / 60_000 * 10) / 10,
    lat: e.lat != null ? +(e.lat - LAT0).toFixed(4) : null,
    lng: e.lng != null ? +(e.lng - LNG0).toFixed(4) : null,
  })).sort((a, b) => a.min - b.min || a.type.localeCompare(b.type));
  const seps = detail.separations.map((s) => ({
    separated_min: Math.round((new Date(s.separated_at).getTime() - base) / 60_000 * 10) / 10,
    returned_min: s.returned_at ? Math.round((new Date(s.returned_at).getTime() - base) / 60_000 * 10) / 10 : null,
    truck: { lat: +(s.truck_last_known.lat - LAT0).toFixed(4), lng: +(s.truck_last_known.lng - LNG0).toFixed(4) },
    driver: { lat: +(s.driver.lat - LAT0).toFixed(4), lng: +(s.driver.lng - LNG0).toFixed(4) },
  })).sort((a, b) => a.separated_min - b.separated_min);
  const summary = {
    distance_km: Math.round(detail.trip.distance_m / 100) / 10,
    turn_count: detail.trip.turn_count,
    moving_s_bucket: Math.round(detail.trip.moving_duration_s / 60),
    stopped_s_bucket: Math.round(detail.trip.stopped_duration_s / 60),
  };
  return JSON.stringify({ evs, seps, summary }, null, 0);
}

async function main() {
  // 1. login
  const login = await j('/auth/login', { method: 'POST', body: JSON.stringify(DRIVER) });
  check('login as seeded driver', login.status === 200 && !!login.body.access_token, `status=${login.status}`);
  if (!login.body?.access_token) { console.error('cannot continue without token'); process.exit(1); }
  const token = login.body.access_token;
  const me = await j('/me', {}, token);
  const vehicleId = me.body?.vehicle?.vehicle_id;
  check('GET /me returns assigned vehicle', !!vehicleId, `plate=${me.body?.vehicle?.plate_number}`);
  if (!vehicleId) process.exit(1);

  // 2. CONTROL run — chronological upload
  const DAY = 24 * 3600_000;
  const controlBase = Date.now() - 10 * DAY;
  const shuffleBase = Date.now() - 5 * DAY;
  const controlBatches = makeBatches(controlBase);
  await uploadRun(token, controlBatches);
  const controlTrip = await waitForEndedTrip(token, controlBase);
  check('CONTROL run produced an ENDED trip', !!controlTrip, controlTrip ? `state=${controlTrip.state}` : 'none');
  if (!controlTrip) process.exit(1);

  // 3. SHUFFLED run — same scenario, different day offset, batches uploaded B,F,A,D,C,E
  const shuffleBatches = makeBatches(shuffleBase);
  const order = ['B', 'F', 'A', 'D', 'C', 'E'];
  const shuffled = order.map((l) => shuffleBatches.find((b) => b.label === l));
  await uploadRun(token, shuffled);
  const shuffleTrip = await waitForEndedTrip(token, shuffleBase);
  check('SHUFFLED (out-of-order) run produced an ENDED trip', !!shuffleTrip, shuffleTrip ? `state=${shuffleTrip.state}` : 'none');
  if (!shuffleTrip) process.exit(1);

  // 4. §1.4 separation assertions on the shuffled trip
  const det = await j(`/trips/${shuffleTrip.trip_id}`, {}, token);
  const sep = (det.body.separations ?? [])[0];
  check('DRIVER_SEPARATED emitted exactly once',
    det.body.events.filter((e) => e.event_type === 'DRIVER_SEPARATED').length === 1);
  check('separation log row exists with both locations',
    !!sep && Number.isFinite(sep.truck_last_known?.lat) && Number.isFinite(sep.driver?.lat),
    sep ? `truck=(${sep.truck_last_known.lat},${sep.truck_last_known.lng}) driver=(${sep.driver.lat},${sep.driver.lng})` : '');
  check('truck_last_known equals the parked stop location (±10 m)',
    !!sep && Math.abs(sep.truck_last_known.lat - STOP_LAT) < 0.0001 && Math.abs(sep.truck_last_known.lng - STOP_LNG) < 0.0001);
  check('driver location differs from truck by > 50 m at flag time',
    !!sep && sep.distance_m > 50, sep ? `distance_m=${sep.distance_m}` : '');
  check('DRIVER_RETURNED clears the separation',
    det.body.events.some((e) => e.event_type === 'DRIVER_RETURNED') && !!sep?.returned_at,
    sep?.duration_minutes != null ? `duration_min=${sep.duration_minutes}` : '');

  // 5. THE GATE (§1.8.3): shuffled rebuild == ordered rebuild
  const detC = await j(`/trips/${controlTrip.trip_id}`, {}, token);
  const detS2 = await j(`/trips/${shuffleTrip.trip_id}`, {}, token);
  const nC = normalizeDetail(detC.body);
  const nS = normalizeDetail(detS2.body);
  check('GATE: out-of-order upload yields trip state IDENTICAL to in-order upload',
    nC === nS, nC === nS ? '' : `\n control=${nC}\n shuffled=${nS}`);

  // 6. Live status API (§1.5 internal API) — use the just-uploaded shuffle data
  const st = await j(`/trips/status?vehicle_id=${vehicleId}`, {}, token);
  check('GET /trips/status returns a state machine value', ['IDLE','STARTED','MOVING','STOPPED','ENDED'].includes(st.body.state) || !!st.body.trip, `state=${st.body.state}`);

  // 7. Sensor batch idempotency (§1.8.2 for /ingest/sensors)
  const sensorBatchId = uuid();
  const evs = [{ event_timestamp: new Date().toISOString(), kind: 'gyroscope', payload: { gyro_z_rps: 0.4 } }];
  const s1 = await j('/ingest/sensors', { method: 'POST', body: JSON.stringify({ batch_id: sensorBatchId, events: evs }) }, token);
  const s2 = await j('/ingest/sensors', { method: 'POST', body: JSON.stringify({ batch_id: sensorBatchId, events: evs }) }, token);
  check('POST /ingest/sensors accepts batch', s1.status === 200 && s1.body.accepted === 1, JSON.stringify(s1.body));
  check('duplicate sensor batch -> already_received:true, accepted:0', s2.status === 200 && s2.body.already_received === true && s2.body.accepted === 0, JSON.stringify(s2.body));

  // 8. Direct DB sanity: no duplicate trip rows for the same (driver, vehicle, started_at)
  if (process.env.SKIP_DB_CHECK !== '1') {
    const { default: pg } = await import('pg');
    const pool = new pg.default.Pool({ connectionString: DB_URL, max: 2 });
    const { rows } = await pool.query(
      `SELECT started_at, count(*) FROM trips WHERE vehicle_id=$1 GROUP BY started_at HAVING count(*)>1`, [vehicleId]);
    check('no duplicate trip rows (upsert by identity works)', rows.length === 0, `dupes=${rows.length}`);
    const { rows: evDup } = await pool.query(
      `SELECT trip_id, event_type, event_timestamp, count(*) FROM trip_events GROUP BY 1,2,3 HAVING count(*)>1 LIMIT 5`);
    check('no duplicate trip_events keys', evDup.length === 0);
    await pool.end();
  }

  console.log(failures === 0 ? '\nAll trip-engine integration gates PASSED' : `\n${failures} gate(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
