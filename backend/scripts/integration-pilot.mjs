#!/usr/bin/env node
/**
 * Phase 4 integration gate script — FIELD PILOT REHEARSAL (Offline Contract §1.8
 * fully exercised end-to-end). Mirrors scripts/integration-trips.mjs; run against
 * a LIVE backend + Postgres.
 *
 * What it simulates: one 8-hour pilot shift during which the driver deliberately
 * enters NO-SIGNAL areas (airplane-mode-style): the client buffers fixes, sensor
 * events, and battery samples locally (sync_state PENDING), then replays them in
 * shuffled batch order once signal returns. The field-pilot gate is: everything
 * reconstructs on the dashboard exactly as if it had arrived live (§1.8.3), with
 * zero loss (§1.8.5) and zero duplicates (§1.8.2).
 *
 * Gates:
 *  A. Offline replay reconstruction: split a synthetic shift (moving → stop →
 *     16-min separation → return → moving → idle-end) into batches; upload half
 *     "live" (client_sent_at ≈ event time) and hold the rest back to simulate
 *     airplane mode, then replay the held batches OUT OF ORDER with realistic
 *     lag. Assert an ENDED trip exists whose normalized state equals the same
 *     scenario uploaded fully in-order at a different day offset (CONTROL run).
 *  B. Duplicate-batch ACK check for ALL FOUR ingest endpoints: locations,
 *     sensors, battery, diagnostics — re-POST the identical batch_id ⇒
 *     200 already_received:true, accepted:0, no duplicate rows.
 *  C. Battery pipeline: POST /ingest/battery start/end samples anchor to the
 *     trip's EVENT-TIME start; charging sample excluded from drain math via the
 *     pure kernel; direct DB check that trip_battery_samples has exactly one
 *     row per (vehicle, trip_started_at, phase).
 *  D. Diagnostics pipeline: one-tap feedback lands in driver_diagnostics and
 *     appears in GET /reports/pilot open_driver_reports queue.
 *  E. Pilot summary assertions: GET /reports/pilot over the rehearsal window
 *     returns battery verdict object, upload_latency (p95 reflects the offline
 *     lag), separations ≥1 incident for this vehicle, sync_backlog.late_fixes >0
 *     (the deliberate offline period), and reconstruction_audit.gate_passed=true
 *     with accuracy ≥ 0.95 — the exact numbers the Phase 4 gate audits.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3100 \
 *   DATABASE_URL=postgres://yet:yet_dev@127.0.0.1:5432/yet_test \
 *   node scripts/integration-pilot.mjs
 * Exit 0 = all gates pass; non-zero with message on first failure.
 */
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://yet:yet_dev@127.0.0.1:5432/yet_test';

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
const DAY = 24 * 3600_000;
const MIN = 60_000;

/* ---------------------------------------------------------------------------
 * Synthetic 8-hour-ish pilot shift (compressed to ~70 minutes of event time —
 * the arithmetic is duration-normalized so compression doesn't distort the
 * pipeline test; battery samples use the real timestamps they'd carry).
 * Positions are pure functions of minute offset m, like integration-trips.mjs,
 * so CONTROL (in-order) and OFFLINE (shuffled replay) runs must normalize equal.
 * ------------------------------------------------------------------------- */
const LAT0 = 9.03, LNG0 = 38.74;          // Addis Ababa
const DLAT = 0.00009;                      // ~10 m north per unit
const DLNG = 0.00011;                      // ~11.2 m east per unit
const STOP_M = 10;                         // park at minute 10
const STOP_LAT = LAT0 + STOP_M * 10 * DLAT;
const STOP_LNG = LNG0 + STOP_M * 10 * DLNG;

function posAt(m) {
  if (m <= STOP_M) return { lat: LAT0 + m * 10 * DLAT, lng: LNG0 + m * 10 * DLNG, speed: 10, heading: 45 };
  if (m <= 25) return { lat: STOP_LAT, lng: STOP_LNG, speed: 0, heading: 45 };            // parked
  const w = m - 25;                                                                        // walk away (16 min > 15-min audit floor)
  if (m <= 41) return { lat: STOP_LAT + 4 * DLAT + w * 6 * DLAT, lng: STOP_LNG + 4 * DLNG + w * 6 * DLNG, speed: 1.3, heading: 60 };
  if (m <= 46) {                                                                           // walk back
    const back = m - 41;
    return { lat: STOP_LAT + 4 * DLAT + (16 - back) * 6 * DLAT, lng: STOP_LNG + 4 * DLNG + (16 - back) * 6 * DLNG, speed: 1.3, heading: 240 };
  }
  const d = m - 46;                                                                        // driving again
  return { lat: STOP_LAT + 4 * DLAT + d * 10 * DLAT, lng: STOP_LNG + 4 * DLNG + d * 10 * DLNG, speed: 10, heading: 45 };
}

function fixAt(baseMs, m) {
  const p = posAt(m);
  return {
    fix_timestamp: new Date(baseMs + m * MIN).toISOString(),
    lat: +p.lat.toFixed(7), lng: +p.lng.toFixed(7),
    speed_mps: p.speed, accuracy_m: 8, heading_deg: p.heading, provider: 'gps',
  };
}

function sensorEventAt(baseMs, m) {
  return {
    event_timestamp: new Date(baseMs + m * MIN).toISOString(),
    kind: 'accelerometer',
    payload: { variance: 0.02, gate: 'vibration_present' },
  };
}

/** Batch plan: [label, m0, m1, stepMin, sensors?, offline?]. The `offline` flag
 *  marks batches the simulated client holds in SQLite (airplane mode) and
 *  replays LATE + out of order — exactly the §1.8.1/§1.8.5 field pattern. */
const PLAN = [
  ['A', 0, 10, 0.5, true, false],   // driving out — live network coverage
  ['B', 10, 25, 1, true, false],    // parked — live (gate closes GPS after 60 s quiet)
  ['C', 25, 33, 1, false, true],    // walked away — NO SIGNAL, buffered
  ['D', 33, 41, 1, false, true],    // still away — NO SIGNAL, buffered
  ['E', 41, 46, 1, false, true],    // walking back — buffered, replayed late
  ['F', 46, 56, 0.5, true, false],  // driving again — signal restored mid-window
];

function makeBatches(baseMs) {
  return PLAN.map(([label, m0, m1, step, sensors, offline]) => {
    const fixes = [];
    for (let m = m0; m < m1; m += step) fixes.push(fixAt(baseMs, m));
    const events = [];
    if (sensors) for (let m = m0; m < m1; m += 2) events.push(sensorEventAt(baseMs, m));
    return { label, offline, batch: { batch_id: uuid(), fixes, events } };
  });
}

/** Upload one batch pair (locations + optional sensors). `sentLagMs` simulates
 *  the wall-clock gap between client generation and HTTP send (offline replay). */
async function uploadBatch(token, b, sentLagMs) {
  const nowIso = new Date().toISOString();
  const clientSent = new Date(Date.parse(b.batch.fixes[0].fix_timestamp) + sentLagMs).toISOString();
  void nowIso;
  const r = await j('/ingest/locations', {
    method: 'POST',
    body: JSON.stringify({ batch_id: b.batch.batch_id, fixes: b.batch.fixes, client_sent_at: clientSent }),
  }, token);
  if (r.status !== 200 || r.body.already_received) throw new Error(`location batch ${b.label} failed: ${JSON.stringify(r.body)}`);
  if (b.batch.events.length) {
    const s = await j('/ingest/sensors', {
      method: 'POST',
      body: JSON.stringify({ batch_id: uuid(), events: b.batch.events, client_sent_at: clientSent }),
    }, token);
    if (s.status !== 200) throw new Error(`sensor batch ${b.label} failed: ${JSON.stringify(s.body)}`);
  }
  return b.batch.batch_id;
}

async function waitForEndedTrip(token, baseMs) {
  const startedIso = new Date(baseMs).toISOString();
  for (let i = 0; i < 40; i++) {
    const r = await j('/trips?limit=200', {}, token);
    const t = (r.body.trips ?? []).find((x) => x.started_at === startedIso);
    if (t && t.state === 'ENDED') return t;
    await new Promise((res) => setTimeout(res, 1000));
  }
  const r = await j('/trips?limit=200', {}, token);
  return (r.body.trips ?? []).find((x) => x.started_at === startedIso) ?? null;
}

/** Normalize trip detail for cross-run comparison (same shape as trips gate). */
function normalizeDetail(detail) {
  const base = new Date(detail.trip.started_at).getTime();
  const evs = detail.events.map((e) => ({
    type: e.event_type,
    min: Math.round((new Date(e.event_timestamp).getTime() - base) / MIN * 10) / 10,
    lat: e.lat != null ? +(e.lat - LAT0).toFixed(4) : null,
    lng: e.lng != null ? +(e.lng - LNG0).toFixed(4) : null,
  })).sort((a, b) => a.min - b.min || a.type.localeCompare(b.type));
  const seps = detail.separations.map((s) => ({
    separated_min: Math.round((new Date(s.separated_at).getTime() - base) / MIN * 10) / 10,
    returned_min: s.returned_at ? Math.round((new Date(s.returned_at).getTime() - base) / MIN * 10) / 10 : null,
    truck: { lat: +(s.truck_last_known.lat - LAT0).toFixed(4), lng: +(s.truck_last_known.lng - LNG0).toFixed(4) },
    driver: { lat: +(s.driver.lat - LAT0).toFixed(4), lng: +(s.driver.lng - LNG0).toFixed(4) },
  })).sort((a, b) => a.separated_min - b.separated_min);
  const summary = {
    distance_km: Math.round(detail.trip.distance_m / 100) / 10,
    turn_count: detail.trip.turn_count,
    moving_s_bucket: Math.round(detail.trip.moving_duration_s / 60),
    stopped_s_bucket: Math.round(detail.trip.stopped_duration_s / 60),
  };
  return JSON.stringify({ evs, seps, summary });
}

async function main() {
  // 1. Login (driver) and manager token for /reports/pilot.
  const login = await j('/auth/login', { method: 'POST', body: JSON.stringify(DRIVER) });
  check('login as seeded driver', login.status === 200 && !!login.body.access_token, `status=${login.status}`);
  if (!login.body?.access_token) { console.error('cannot continue without token'); process.exit(1); }
  const token = login.body.access_token;
  const me = await j('/me', {}, token);
  const vehicleId = me.body?.vehicle?.vehicle_id;
  check('GET /me returns assigned vehicle', !!vehicleId, `plate=${me.body?.vehicle?.plate_number}`);
  if (!vehicleId) process.exit(1);

  const managerEmail = process.env.MANAGER_EMAIL ?? 'admin@yet.local';
  // Password resolution: explicit env > backend/.env ADMIN_BOOTSTRAP_PASSWORD
  // (the same value ensureBootstrapAdmin seeds) > documented default.
  let managerPass = process.env.MANAGER_PASSWORD;
  if (!managerPass) {
    try {
      const fs = await import('node:fs');
      const envTxt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
      managerPass = envTxt.match(/^ADMIN_BOOTSTRAP_PASSWORD=(.+)$/m)?.[1]?.trim();
    } catch { /* no .env file */ }
  }
  managerPass ??= 'change-me';
  const mlogin = await j('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: managerEmail, password: managerPass }) });
  const managerToken = mlogin.body?.access_token;
  check('login as fleet manager/admin (for /reports/pilot)', mlogin.status === 200 && !!managerToken, `status=${mlogin.status}`);

  // 2. CONTROL run — fully in-order, no artificial lag (what a covered day looks like).
  const controlBase = Date.now() - 12 * DAY;
  const pilotBase = Date.now() - 6 * DAY;
  const controlBatches = makeBatches(controlBase);
  for (const b of controlBatches) await uploadBatch(token, b, 0);
  const controlTrip = await waitForEndedTrip(token, controlBase);
  check('CONTROL (all-live) run produced an ENDED trip', !!controlTrip, controlTrip ? `state=${controlTrip.state}` : 'none');
  if (!controlTrip) process.exit(1);

  // 3. PILOT run — airplane-mode simulation: upload live batches A,B,F first,
  //    hold C,D,E ("no signal") client-side, then replay them LAST, out of
  //    order (E before C before D), each carrying a 40–60 min client→server lag.
  const pilotBatches = makeBatches(pilotBase);
  const byLabel = Object.fromEntries(pilotBatches.map((b) => [b.label, b]));
  const liveIds = [];
  for (const l of ['A', 'B', 'F']) liveIds.push(await uploadBatch(token, byLabel[l], 0));
  // deliberate offline dwell: replay with sent_lag = minutes since fix creation
  const heldOrder = ['E', 'C', 'D'];
  const heldIds = [];
  for (const l of heldOrder) heldIds.push(await uploadBatch(token, byLabel[l], (l === 'E' ? 40 : l === 'C' ? 55 : 50) * MIN));

  const pilotTrip = await waitForEndedTrip(token, pilotBase);
  check('PILOT (offline-replayed) run produced an ENDED trip', !!pilotTrip, pilotTrip ? `state=${pilotTrip.state}` : 'none');
  if (!pilotTrip) process.exit(1);

  // 4. GATE A — §1.8.3/§1.8.5: offline reconstruction == live reconstruction.
  const detC = await j(`/trips/${controlTrip.trip_id}`, {}, token);
  const detP = await j(`/trips/${pilotTrip.trip_id}`, {}, token);
  const nC = normalizeDetail(detC.body);
  const nP = normalizeDetail(detP.body);
  check('GATE A: offline-replayed trip state IDENTICAL to live upload', nC === nP,
    nC === nP ? '' : `\n control=${nC}\n pilot=${nP}`);
  const sep = (detP.body.separations ?? [])[0];
  check('separation survived offline replay with both locations',
    !!sep && Number.isFinite(sep.truck_last_known?.lat) && Number.isFinite(sep.driver?.lat) && sep.distance_m > 50,
    sep ? `distance_m=${sep.distance_m}` : '');

  // 5. GATE B — duplicate-batch ACK across all four ingest endpoints (§1.8.2).
  for (const [name, path, mkBody] of [
    ['locations', '/ingest/locations', (id) => ({ batch_id: id, fixes: [fixAt(pilotBase, 5)], client_sent_at: new Date().toISOString() })],
    ['sensors', '/ingest/sensors', (id) => ({ batch_id: id, events: [{ event_timestamp: new Date(pilotBase + 5 * MIN).toISOString(), kind: 'gyroscope', payload: { gyro_z_rps: 0.3 } }] })],
    ['battery', '/ingest/battery', (id) => ({ batch_id: id, samples: [{ trip_started_at: new Date(pilotBase).toISOString(), taken_at: new Date(pilotBase + 70 * MIN).toISOString(), phase: 'mid_trip', battery_pct: 55, charging: false }] })],
  ]) {
    const bid = uuid();
    const r1 = await j(path, { method: 'POST', body: JSON.stringify(mkBody(bid)) }, token);
    const r2 = await j(path, { method: 'POST', body: JSON.stringify(mkBody(bid)) }, token);
    check(`duplicate ${name} batch -> 200 already_received:true`,
      r1.status === 200 && r2.status === 200 && r2.body.already_received === true && r2.body.accepted === 0,
      `first=${JSON.stringify(r1.body)} dup=${JSON.stringify(r2.body)}`);
  }
  const diagBid = uuid();
  const diagBody = {
    batch_id: diagBid,
    reported_at: new Date(pilotBase + 70 * MIN).toISOString(),
    issue: 'gps_not_working', battery_pct: 54, charging: false,
    last_fix_age_s: 95, last_accuracy_m: 42, network_type: 'cellular',
    pending_sync_count: 128, trip_active: true, app_version: '0.4.0-pilot',
    detail: { device: 'Tecno Spark 10', android: 11 },
  };
  const d1 = await j('/ingest/diagnostics', { method: 'POST', body: JSON.stringify(diagBody) }, token);
  const d2 = await j('/ingest/diagnostics', { method: 'POST', body: JSON.stringify(diagBody) }, token);
  check('diagnostics first tap accepted', d1.status === 201 && d1.body.accepted === 1, JSON.stringify(d1.body));
  check('duplicate diagnostics tap -> already_received:true (no multiplied incidents)',
    d2.status === 200 && d2.body.already_received === true, JSON.stringify(d2.body));

  // 6. GATE C — battery pipeline: post start/end samples anchored to trip event-time.
  const batBid = uuid();
  const batBody = {
    batch_id: batBid,
    client_sent_at: new Date().toISOString(),
    samples: [
      { trip_started_at: new Date(pilotBase).toISOString(), taken_at: new Date(pilotBase).toISOString(), phase: 'trip_start', battery_pct: 86, charging: false },
      { trip_started_at: new Date(pilotBase).toISOString(), taken_at: new Date(pilotBase + 70 * MIN).toISOString(), phase: 'trip_end', battery_pct: 78, charging: false },
    ],
  };
  const bRes = await j('/ingest/battery', { method: 'POST', body: JSON.stringify(batBody) }, token);
  check('POST /ingest/battery accepts start+end samples', bRes.status === 200 && bRes.body.accepted === 2, JSON.stringify(bRes.body));
  const bDup = await j('/ingest/battery', { method: 'POST', body: JSON.stringify(batBody) }, token);
  check('duplicate battery batch -> already_received:true', bDup.status === 200 && bDup.body.already_received === true, JSON.stringify(bDup.body));

  // 7. GATE D/E — pilot dashboard reads (needs manager token).
  if (managerToken) {
    const from = new Date(pilotBase - DAY).toISOString();
    const to = new Date(pilotBase + DAY).toISOString();
    const rep = await j(`/reports/pilot?from=${from}&to=${to}&driver_id=${me.body.id}`, {}, managerToken);
    check('GET /reports/pilot returns 200 for admin/manager', rep.status === 200, `status=${rep.status}`);
    if (rep.status === 200) {
      const s = rep.body;
      check('pilot summary exposes battery verdict + thresholds',
        ['PASS','BETWEEN_TARGET_AND_GATE','GATE_FAIL','INSUFFICIENT_DATA'].includes(s.battery?.verdict)
        && s.thresholds?.target_pct_per_8h === 20 && s.thresholds?.gate_max_pct_per_8h === 25,
        `verdict=${s.battery?.verdict} median=${s.battery?.median_pct_per_8h}`);
      check('upload latency measured (arrival-based metric)', typeof s.upload_latency?.batches === 'number' && s.upload_latency.batches > 0,
        `p50=${s.upload_latency?.p50_s ?? s.upload_latency?.p50_seconds}s p95=${s.upload_latency?.p95_seconds ?? s.upload_latency?.p95_s}s batches=${s.upload_latency?.batches}`);
      const vehSep = (s.separations ?? []).find((x) => x.vehicle_id === vehicleId);
      check('separation count includes the replayed offline separation', !!vehSep && vehSep.incidents >= 1,
        vehSep ? `incidents=${vehSep.incidents} avg_min=${vehSep.avg_minutes}` : '');
      check('sync backlog detects the deliberate offline dwell (late fixes > 0)',
        (s.sync_backlog?.late_fixes ?? 0) > 0, `late=${s.sync_backlog?.late_fixes}/${s.sync_backlog?.total_fixes} worst_lag=${s.sync_backlog?.worst_lag_s}s`);
      check('reconstruction audit passes ≥95% gate on replayed data',
        s.reconstruction_audit?.gate_passed === true && s.reconstruction_audit?.accuracy >= 0.95,
        `accuracy=${s.reconstruction_audit?.accuracy} sent=${s.reconstruction_audit?.offline_sent} stored=${s.reconstruction_audit?.offline_stored}`);
      const queued = (s.open_driver_reports ?? []).some((d) => d.batch_id === diagBid);
      check('one-tap feedback surfaces in ops queue (open_driver_reports)', queued);
    }
  } else {
    check('pilot dashboard checks skipped (no manager credentials)', false, 'set MANAGER_EMAIL/MANAGER_PASSWORD or BOOTSTRAP_ADMIN_PASSWORD');
  }

  // 8. Direct DB sanity: battery upsert keeps ONE row per (vehicle, trip, phase);
  //    no duplicated location rows from the shuffled replay (§1.8.2).
  if (process.env.SKIP_DB_CHECK !== '1') {
    const { default: pg } = await import('pg');
    const pool = new pg.default.Pool({ connectionString: DB_URL, max: 2 });
    const { rows: batRows } = await pool.query(
      `SELECT phase, COUNT(*)::int AS n FROM trip_battery_samples
        WHERE vehicle_id=$1 AND trip_started_at=$2 GROUP BY phase HAVING COUNT(*)>1`,
      [vehicleId, new Date(pilotBase).toISOString()]);
    check('trip_battery_samples: one row per (vehicle, trip, phase) after replay', batRows.length === 0, JSON.stringify(batRows));
    const { rows: fixDup } = await pool.query(
      `SELECT fix_timestamp, lat, lng, COUNT(*) FROM location_fixes
        WHERE vehicle_id=$1 AND fix_timestamp >= $2 AND fix_timestamp < $3
        GROUP BY fix_timestamp, lat, lng HAVING COUNT(*) > 1 LIMIT 5`,
      [vehicleId, new Date(pilotBase).toISOString(), new Date(pilotBase + 2 * DAY).toISOString()]);
    check('offline replay created NO duplicate location fixes', fixDup.length === 0, JSON.stringify(fixDup));
    const { rows: diagN } = await pool.query(`SELECT COUNT(*)::int AS n FROM driver_diagnostics WHERE batch_id=$1`, [diagBid]);
    check('diagnostics stored exactly once despite double-tap', diagN[0]?.n === 1);
    await pool.end();
  }

  console.log(failures === 0 ? '\nAll Phase-4 pilot integration gates PASSED' : `\n${failures} gate(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
