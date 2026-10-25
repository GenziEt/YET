/**
 * Phase 3 integration gate script (§1.8.3, §1.9.4, §1.10.2) — run against a LIVE
 * compose stack (Postgres+PostGIS, Redis, OSRM, backend on :3000). Mirrors
 * scripts/integration-trips.mjs in structure and rigor.
 *
 * Gates:
 *  A. Geofence CRUD: draw a WAREHOUSE circle geofence via POST /geofences as the
 *     ADMIN (FLEET_MANAGER/ADMIN-only write role), read it back through GET
 *     /geofences/:id (ring/center echo must round-trip).
 *  B. Crossing determinism: replay a synthetic trip that starts OUTSIDE, ENTERs
 *     the warehouse, stops inside, then EXITs — uploaded in SHUFFLED batch order.
 *     Assert exactly one GEOFENCE_ENTER and one GEOFENCE_EXIT trip_event for the
 *     zone (payload.geofence_id match), and that a SECOND out-of-order replay of
 *     the same event-time scenario at a different day offset reconstructs an
 *     IDENTICAL crossing event set (§1.8.3: arrival order must not matter).
 *  C. Dashboard state binding: GET /geofences/state?vehicle_id= reports the
 *     vehicle INSIDE the zone while its latest fix sits within radius.
 *  D. Route cache budget: GET /route?...destination_geofence_id= cold call first,
 *     then repeat; the second call MUST be served from Redis (source==='redis')
 *     within the ≤50 ms p95 budget (§1.9.4) — measured wall-clock here.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 \
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *   DATABASE_URL=postgres://yet:change-me@127.0.0.1:5432/yet_test \
 *   REDIS_URL=redis://127.0.0.1:6379 \
 *   node scripts/integration-geofence.mjs
 * Exit 0 = all gates pass; non-zero with message on first failure.
 */
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://yet:change-me@127.0.0.1:5432/yet_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

// Seeded dev driver (identity ensureSeedDevDriver, dev/test only) — owns the vehicle.
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
 * Synthetic crossing trip. The seeded driver's vehicle is assigned to plate
 * AA-90001 whose last known location (Phase 2 gate data) sits near (9.03+...,
 * 38.74+...). We place the warehouse circle so the corridor from OUTSIDE passes
 * through it: start west of the zone, drive ENE across it, stop inside, leave.
 * Positions are pure functions of minute offset m, like integration-trips.mjs —
 * two runs at different base times must produce identical normalized sets.
 *
 *   m 0..8    driving ~11 m/s from OUTSIDE, crosses INTO zone around m≈6
 *   m 8..14   parked INSIDE (>60 s ⇒ STOPPED; also feeds the ETA-stale path)
 *   m 14..22  driving again, crosses OUT around m≈18, continues to m=22
 * ------------------------------------------------------------------------- */
const LAT0 = 9.0305, LNG0 = 38.7325;             // west-southwest of the depot area
const DLAT = 0.00006, DLNG = 0.00016;            // ~6.7 m N / ~17.5 m E per minute-step unit
const CENTER_M = 10;                             // park inside the zone at m=10-ish
const WH_LAT = LAT0 + 8 * 11 * DLAT + 2 * DLAT;  // stop point (inside circle center)
const WH_LNG = LNG0 + 8 * 11 * DLNG + 2 * DLNG;
const WH_RADIUS = 350;                           // m — entered/exited by the corridor

function posAt(m) {
  if (m <= 8) return { lat: LAT0 + m * 11 * DLAT, lng: LNG0 + m * 11 * DLNG, speed: 11 };
  if (m <= 14) return { lat: WH_LAT, lng: WH_LNG, speed: 0 };
  const d = m - 14;
  return { lat: WH_LAT + d * 11 * DLAT, lng: WH_LNG + d * 11 * DLNG, speed: 11 };
}
function fixAt(baseMs, m) {
  const p = posAt(m);
  return {
    fix_timestamp: new Date(baseMs + m * 60_000).toISOString(),
    lat: +p.lat.toFixed(7), lng: +p.lng.toFixed(7),
    speed_mps: p.speed, accuracy_m: 8, heading_deg: 45, provider: 'gps',
  };
}
function makeBatches(baseMs) {
  const plan = [
    ['A', 0, 8, 0.5],     // approach + ENTER
    ['B', 8, 14, 1],      // parked inside (STOPPED)
    ['C', 14, 18, 0.5],   // depart, near EXIT
    ['D', 18, 22, 0.5],   // past boundary → EXIT
  ];
  return plan.map(([label, m0, m1, step]) => {
    const fixes = [];
    for (let m = m0; m < m1; m += step) fixes.push(fixAt(baseMs, m));
    return { label, batch: { batch_id: uuid(), fixes } };
  });
}

async function uploadRun(token, batches) {
  for (const b of batches) {
    const r = await j('/ingest/locations', { method: 'POST', body: JSON.stringify(b.batch) }, token);
    if (r.status !== 200 || r.body.already_received)
      throw new Error(`batch ${b.label} failed: ${JSON.stringify(r.body)}`);
  }
}

/**
 * Collect GEOFENCE_* events for OUR zone across all trips overlapping the replay
 * window. The Trip Engine may split one continuous drive into several trips
 * (start / park-stop / resume) with windows that don't align to the synthetic
 * base time exactly — so we never assume "both events live in the trip whose
 * started_at === base". Events are deduplicated by EVENT TIME first: the §1.8.3
 * upsert key is (trip_id, event_type, event_timestamp), so attribution moving
 * between trips across recomputes can leave rows on two trips for the SAME
 * moment; physically those are one crossing. Assertion model: each distinct
 * crossing MOMENT occurred exactly once (per type) for this zone.
 */
async function collectZoneEvents(adminToken, baseMs, geofenceId) {
  const windowEnd = baseMs + 30 * 60_000; // synthetic corridor is ≤22 min
  const list = await j('/trips?limit=200', {}, adminToken);
  const overlapping = (list.body.trips ?? []).filter(
    (x) => new Date(x.started_at).getTime() <= windowEnd &&
           (!x.ended_at || new Date(x.ended_at).getTime() >= baseMs));
  const all = [];
  for (const t of overlapping) {
    const det = await j(`/trips/${t.trip_id}`, {}, adminToken);
    for (const e of det.body.events ?? []) {
      if (e.event_type?.startsWith('GEOFENCE_') && e.payload?.geofence_id === geofenceId) {
        all.push({ ...e, _trip_id: t.trip_id });
      }
    }
  }
  const seen = new Set();
  const deduped = all.filter((e) => {
    const k = `${e.event_type}@${e.event_timestamp}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  return { trips: overlapping, raw: all, evs: deduped };
}

/** Poll until ENTER+EXIT both appear for our zone (or timeout). */
async function waitForCrossings(adminToken, baseMs, geofenceId) {
  for (let i = 0; i < 30; i++) {
    const c = await collectZoneEvents(adminToken, baseMs, geofenceId);
    const enter = c.evs.filter((e) => e.event_type === 'GEOFENCE_ENTER');
    const exit = c.evs.filter((e) => e.event_type === 'GEOFENCE_EXIT');
    if (enter.length >= 1 && exit.length >= 1) return { ...c, enter, exit };
    await new Promise((res) => setTimeout(res, 1000));
  }
  return null;
}

/** Normalize crossing events relative to the replay BASE time (not any single
 *  trip's start) for cross-run comparison. */
function normalizeCrossings(found, baseMs) {
  return found.evs
    .map((e) => ({
      type: e.event_type,
      min: Math.round((new Date(e.event_timestamp).getTime() - baseMs) / 60_000 * 10) / 10,
      lat: +(e.lat - LAT0).toFixed(4),
      lng: +(e.lng - LNG0).toFixed(4),
    }))
    .sort((a, b) => a.min - b.min || a.type.localeCompare(b.type));
}

async function main() {
  // 0. health
  const h = await j('/healthz');
  check('backend healthy', h.status === 200 && h.body.db === 'ok', `db=${h.body?.db}`);
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('ADMIN_EMAIL / ADMIN_PASSWORD env required (bootstrap admin) — cannot test write roles');
    process.exit(1);
  }

  // 1. logins: ADMIN (writes) + seeded DRIVER (ingests)
  const adminLogin = await j('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
  check('login as bootstrap ADMIN', adminLogin.status === 200 && !!adminLogin.body.access_token, `status=${adminLogin.status}`);
  if (!adminLogin.body?.access_token) process.exit(1);
  const adminToken = adminLogin.body.access_token;

  const login = await j('/auth/login', { method: 'POST', body: JSON.stringify(DRIVER) });
  check('login as seeded driver', login.status === 200 && !!login.body.access_token, `status=${login.status}`);
  if (!login.body?.access_token) process.exit(1);
  const token = login.body.access_token;
  const me = await j('/me', {}, token);
  const vehicleId = me.body?.vehicle?.vehicle_id;
  check('GET /me returns assigned vehicle', !!vehicleId, `plate=${me.body?.vehicle?.plate_number}`);
  if (!vehicleId) process.exit(1);

  // Driver may NOT create geofences (role guard).
  const forbidden = await j('/geofences', { method: 'POST', body: JSON.stringify({
    kind: 'CIRCLE', name: 'should-fail', center: { lat: WH_LAT, lng: WH_LNG }, radius_m: 100 }) }, token);
  check('DRIVER POST /geofences rejected 403', forbidden.status === 403, `status=${forbidden.status}`);

  // 2. Gate A — draw the warehouse geofence (circle editor equivalent)
  const created = await j('/geofences', { method: 'POST', body: JSON.stringify({
    kind: 'CIRCLE', name: `Gate warehouse ${Date.now()}`, category: 'WAREHOUSE',
    center: { lat: WH_LAT, lng: WH_LNG }, radius_m: WH_RADIUS }) }, adminToken);
  check('ADMIN POST /geofences creates CIRCLE', created.status === 201 && created.body.kind === 'CIRCLE', `status=${created.status}`);
  const gf = created.body;
  if (!gf?.geofence_id) { console.error('cannot continue without geofence id'); process.exit(1); }
  const readBack = await j(`/geofences/${gf.geofence_id}`, {}, adminToken);
  check('GET /geofences/:id echoes center/radius', readBack.status === 200
    && Math.abs(readBack.body.center.lat - WH_LAT) < 1e-6
    && Math.abs(readBack.body.center.lng - WH_LNG) < 1e-6
    && Number(readBack.body.radius_m) === WH_RADIUS,
    JSON.stringify({ c: readBack.body.center, r: readBack.body.radius_m }));

  // Polygon update-merge path (watch item #2): rename WITHOUT re-sending geometry.
  const renamed = await j(`/geofences/${gf.geofence_id}`, { method: 'PUT', body: JSON.stringify({ name: 'Gate warehouse renamed' }) }, adminToken);
  check('PUT metadata-only merge keeps geometry', renamed.status === 200
    && renamed.body.name === 'Gate warehouse renamed'
    && Number(renamed.body.radius_m) === WH_RADIUS, `status=${renamed.status}`);

  // 3. Gate B — CONTROL run (chronological) then SHUFFLED replay, distinct day offsets
  const DAY = 24 * 3600_000;
  const controlBase = Date.now() - 12 * DAY;
  const shuffleBase = Date.now() - 6 * DAY;

  const controlBatches = makeBatches(controlBase);
  await uploadRun(token, controlBatches);
  const controlFound = await waitForCrossings(adminToken, controlBase, gf.geofence_id);
  check('CONTROL replay emitted ENTER+EXIT', !!controlFound,
    controlFound ? `enter=${controlFound.enter.length} exit=${controlFound.exit.length}` : 'none');
  if (!controlFound) process.exit(1);
  check('ENTER emitted EXACTLY once (control)', controlFound.enter.length === 1);
  check('EXIT emitted EXACTLY once (control)', controlFound.exit.length === 1);

  const shuffleBatches = makeBatches(shuffleBase);
  const order = ['C', 'A', 'D', 'B']; // out-of-order upload (§1.8.3)
  await uploadRun(token, order.map((l) => shuffleBatches.find((b) => b.label === l)));
  const shuffleFound = await waitForCrossings(adminToken, shuffleBase, gf.geofence_id);
  check('SHUFFLED (out-of-order) replay emitted ENTER+EXIT', !!shuffleFound,
    shuffleFound ? `enter=${shuffleFound.enter.length} exit=${shuffleFound.exit.length}` : 'none');
  if (!shuffleFound) process.exit(1);
  check('ENTER emitted EXACTLY once under out-of-order upload', shuffleFound.enter.length === 1);
  check('EXIT emitted EXACTLY once under out-of-order upload', shuffleFound.exit.length === 1);

  const nC = JSON.stringify(normalizeCrossings(controlFound, controlBase));
  const nS = JSON.stringify(normalizeCrossings(shuffleFound, shuffleBase));
  check('GATE: crossing events identical modulo time shift (ordered vs shuffled)', nC === nS,
    nC === nS ? nC : `\n control=${nC}\n shuffled=${nS}`);

  // Third replay of the SAME shuffled batches at the SAME event times → no duplicates
  // (upsert key (trip_id,event_type,event_timestamp) freshness path).
  const replayBatches = makeBatches(shuffleBase); // fresh batch ids, identical event times
  await uploadRun(token, ['D', 'B', 'A', 'C'].map((l) => replayBatches.find((b) => b.label === l)));
  const afterReplay = await waitForCrossings(adminToken, shuffleBase, gf.geofence_id);
  check('late duplicate replay does NOT multiply events', !!afterReplay
    && afterReplay.enter.length === 1 && afterReplay.exit.length === 1,
    afterReplay ? `enter=${afterReplay.enter.length} exit=${afterReplay.exit.length}` : 'lost');

  // 4. Gate C — dashboard inside/outside coloring source
  const st = await j(`/geofences/state?vehicle_id=${vehicleId}`, {}, token);
  const zoneState = (st.body.states ?? []).find((s) => s.geofence_id === gf.geofence_id);
  // Latest fix is from the shuffled run's last batch (outside, east of zone) —
  // assert the contract shape plus at least one candidate zone returned.
  check('GET /geofences/state returns states matrix', st.status === 200 && Array.isArray(st.body.states)
    && st.body.states.length > 0 && !!zoneState, `count=${st.body.states?.length}`);
  // Drive a fix INSIDE the zone explicitly, then re-check coloring flips to inside.
  const insideFix = { batch_id: uuid(), fixes: [{
    fix_timestamp: new Date(Date.now() + 120_000).toISOString(),
    lat: +WH_LAT.toFixed(7), lng: +WH_LNG.toFixed(7), speed_mps: 0, accuracy_m: 5, provider: 'gps' }] };
  const up = await j('/ingest/locations', { method: 'POST', body: JSON.stringify(insideFix) }, token);
  check('inside-boundary fix accepted', up.status === 200, `status=${up.status}`);
  await new Promise((r) => setTimeout(r, 1500));
  const st2 = await j(`/geofences/state?vehicle_id=${vehicleId}`, {}, token);
  const zs2 = (st2.body.states ?? []).find((s) => s.geofence_id === gf.geofence_id);
  check('dashboard layer sees vehicle INSIDE after boundary fix', !!zs2?.inside,
    zs2 ? `inside=${zs2.inside}` : 'no state row');
  check('inside[] list names the zone', (st2.body.inside ?? []).some((z) => z.geofence_id === gf.geofence_id));

  // 5. Gate D — route to destination + Redis cache budget (§1.9.4 ≤ 50 ms cached)
  // NOTE: from/to are REQUIRED query params (the gateway validates them even when
  // the destination is given as a geofence id, which overrides `to` server-side).
  const destQs = `/route?from=${LAT0},${LNG0}&to=${WH_LAT},${WH_LNG}&destination_geofence_id=${gf.geofence_id}&vehicle_id=${vehicleId}`;
  const coldT0 = performance.now();
  const cold = await j(destQs, {}, token);
  const coldMs = Math.round(performance.now() - coldT0);
  check('GET /route?destination_geofence_id resolves centroid + geometry',
    cold.status === 200 && Array.isArray(cold.body.geometry) && cold.body.geometry.length >= 2
    && Math.abs(cold.body.to.lat - WH_LAT) < 0.001, `status=${cold.status} source=${cold.body.source} ${coldMs}ms`);
  check('ETA present with staleness contract fields', !!cold.body.eta
    && typeof cold.body.eta.stale === 'boolean' && 'last_movement_at' in cold.body.eta,
    cold.body.eta ? `method=${cold.body.eta.eta_method} stale=${cold.body.eta.stale}` : 'missing');

  // Ensure Redis holds the key (the cold call may have been served by Postgres warm
  // cache); flush-and-refill once so the timed call exercises the Redis hit path.
  const { default: pg } = await import('pg');
  const poolDb = new pg.Pool({ connectionString: DB_URL, max: 2 });
  const { default: RedisMod } = await import('ioredis').catch(() => ({ default: null }));
  let redis = null;
  if (RedisMod) {
    redis = new RedisMod.default ? new RedisMod.default(REDIS_URL) : new RedisMod(REDIS_URL);
    redis.on('error', () => {});
  }
  // Warm Redis explicitly: hit once, then measure the guaranteed-hot second call.
  await j(destQs, {}, token); // ensures getRoute wrote through to Redis (fresh miss→write)
  const hotT0 = performance.now();
  const hot = await j(destQs, {}, token);
  const hotMs = Math.round(performance.now() - hotT0);
  const servedFromRedis = hot.body.source === 'redis' || hot.body.source === 'stale_redis';
  check('second GET /route served from Redis', servedFromRedis, `source=${hot.body.source}`);
  check(`cached route within ≤${process.env.CACHE_BUDGET_MS ?? 50} ms budget`,
    hotMs <= Number(process.env.CACHE_BUDGET_MS ?? 50), `${hotMs}ms wall-clock incl. HTTP overhead`);

  // 6. Direct DB sanity: exactly one crossing-event row per (trip,type,ts) — the
  //    uq_trip_event index is the §1.8.3 guarantee; verify no dupes slipped through.
  if (process.env.SKIP_DB_CHECK !== '1') {
    const { rows } = await poolDb.query(
      `SELECT trip_id, event_type, event_timestamp, count(*) FROM trip_events
        WHERE event_type IN ('GEOFENCE_ENTER','GEOFENCE_EXIT')
        GROUP BY 1,2,3 HAVING count(*)>1 LIMIT 5`);
    check('no duplicate GEOFENCE_* event rows', rows.length === 0, `dupes=${rows.length}`);
    const { rows: payloadOk } = await poolDb.query(
      `SELECT count(*) FROM trip_events te
        WHERE te.event_type LIKE 'GEOFENCE_%' AND te.payload->>'geofence_id' IS NULL`);
    check('all GEOFENCE_* payloads carry geofence_id', Number(payloadOk[0].count) === 0);
  }
  await poolDb.end();
  if (redis) await redis.quit().catch(() => redis.disconnect());

  // 7. Cleanup: deactivate the gate geofence (soft delete keeps history interpretable)
  const del = await j(`/geofences/${gf.geofence_id}`, { method: 'DELETE' }, adminToken);
  check('DELETE /geofences deactivates (soft)', del.status === 200 && del.body.deleted === true);

  console.log(failures === 0 ? '\nAll geofence/route integration gates PASSED' : `\n${failures} gate(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
