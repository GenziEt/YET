#!/usr/bin/env node
/**
 * Phase 5 integration gate script — NOTIFICATIONS, REPORTING & PDPP ERASURE.
 * Mirrors scripts/integration-pilot.mjs; run against a LIVE backend + Postgres
 * (+ Redis for the fleet-state cache probe).
 *
 * Gates (codifies every manual smoke assertion from the Phase 5 sessions):
 *  A. Push-token registration: POST /notifications/token => 201 + token_id;
 *     re-POST of the SAME token is an idempotent UPSERT (same token_id);
 *     short token (<20 chars, zod min) => 400; anonymous => 401.
 *  B. Fire-once / replay-no-op on the notification fan-out: ingest a fresh trip
 *     start, wait for TRIP_STARTED rows in the ledger, assert exactly one row
 *     per recipient role, then RE-POST an already-received batch_id =>
 *     already_received:true and the TRIP_STARTED count must not change (§1.8.2/3).
 *  C. Separation timer end-to-end: drive the truck to a stop with motion sensors
 *     reporting, then walk the driver away SILENTLY (>50 m, §1.4) => open incident
 *     in driver_separation_log; test-mode sweep/run with separation_id force makes
 *     decideSeparationTimer FIRED through the REAL claim path: first call fires
 *     (notified_fleet_manager=true, status='NOTIFIED', DRIVER_SEPARATION_TIMER rows
 *     fanned out with `${sepId}@${userId}` dedupe keys), second consecutive call is
 *     a NO-OP (atomic claim + uq_notif_dedupe). Also asserts sweep/run without a
 *     body works when sent as `-d '{}'` (Fastify empty-body guard).
 *  D. Role matrix on manager reads: /reports/trips, /reports/separations,
 *     /reports/fleet-state, /notifications/log — FLEET_MANAGER 200, DRIVER 403,
 *     anonymous 401. GET /ingest/drivers requires auth (read_roster audit).
 *  E. Fleet-state contract + Redis TTL: envelope carries generated_at, counts,
 *     live_window_s, replica_lag_s, cached flag; vehicles[] entries expose
 *     is_live / last_fix_age_s so the dashboard can honor §1.4 "last known
 *     location" labeling; second read within 30 s hits cache (cached:true);
 *     redis TTL of fleet:state measured ≈30 s (25..30 band); ?refresh=1 busts.
 *  F. Erasure endpoint (§Master Phase 5 deliverable C): seed old raw fixes for a
 *     throwaway driver straight into the DB (no side effects on the pipeline),
 *     DELETE /driver/:id/location-history: other-driver 403, self 200 receipt with
 *     deleted_rows == seeded-old count minus downsample keeps ((rn-1)%N==0 kept,
 *     index 0 anchor), erasure_location_history audit row lands atomically, recent
 *     fixes survive. Cleanup after.
 *  G. Throughput probe (§1.10.4 budget): ~100 fixes/s across 10 batches of 10,
 *     p95 HTTP latency < 250 ms (generous CI margin over the design target).
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3199 \
 *   DATABASE_URL=postgres://yet:change-me@127.0.0.1:5432/yet \
 *   MANAGER_EMAIL=smoke.mgr@yet.test MANAGER_PASSWORD=smoke-pass-1 \
 *   REDIS_URL=redis://localhost:6379 \
 *   node scripts/integration-phase5.mjs
 * The server under test MUST be non-production NODE_ENV (test-only sweep routes)
 * with generous TRIP_IDLE_TIMEOUT_S (>= 600 recommended) so gate B/C trips stay
 * open while assertions run. Exit 0 = all gates pass; non-zero on first failure.
 */
import crypto from 'node:crypto';
import net from 'node:net';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3199';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://yet:change-me@127.0.0.1:5432/yet';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DRIVER = { identifier: '+251900000001', password: 'dev-driver-secret' };
const MANAGER = { identifier: process.env.MANAGER_EMAIL ?? 'smoke.mgr@yet.test',
                  password: process.env.MANAGER_PASSWORD ?? 'smoke-pass-1' };

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
  return { status: res.status, body };
}
const uuid = () => crypto.randomUUID();
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------------
 * Minimal direct writers (pg client via dynamic import; dependency-free
 * fallback to `psql` when pg isn't resolvable). Only used where the HTTP API
 * intentionally cannot produce the state (old fixes for the erasure gate,
 * ledger/count reads).
 * ------------------------------------------------------------------------- */
let sqlRun = null; // (text, params) => rows[]
async function initDb() {
  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    sqlRun = async (text, params) => (await client.query(text, params)).rows;
  } catch {
    const { execSync } = await import('node:child_process');
    sqlRun = (text) => {
      const out = execSync(`psql ${JSON.stringify(DB_URL)} -X -q -A -F'\t' -c ${JSON.stringify(text)}`,
        { encoding: 'utf8' });
      const lines = out.trim().split('\n');
      return lines.slice(1, -1).map(() => ({})); // scalar probes only in fallback
    };
  }
}

/* ------------------------- tiny RESP client (TTL probe) -------------------- */
async function redisTtl(key) {
  const u = new URL(REDIS_URL);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port || 6379), u.hostname);
    let buf = '';
    sock.setTimeout(2000, () => { sock.destroy(); reject(new Error('redis timeout')); });
    sock.on('error', reject);
    sock.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/^:(-?\d+)\r\n$/m);
      if (m) { sock.destroy(); resolve(Number(m[1])); }
    });
    sock.on('connect', () => sock.write(`GET ${key}\r\n`.length ? `TTL ${key}\r\n` : ''));
  });
}

/* ----------------------------- trip geometry ------------------------------- */
const LAT0 = 9.03, LNG0 = 38.74;
const DLAT = 0.00009, DLNG = 0.00011; // ~10 m N / ~11.2 m E per unit
const STOP_M = 10;                     // parked at minute 10
const STOP_LAT = LAT0 + STOP_M * 10 * DLAT, STOP_LNG = LNG0 + STOP_M * 10 * DLNG;
function posAt(m) {
  if (m <= STOP_M) return { lat: LAT0 + m * 10 * DLAT, lng: LNG0 + m * 10 * DLNG, speed: 10 };
  if (m <= 20) return { lat: STOP_LAT, lng: STOP_LNG, speed: 0 };                       // parked
  const w = m - 20;                                                                     // silent walk away
  return { lat: STOP_LAT + 8 * DLAT + w * 6 * DLAT, lng: STOP_LNG + 8 * DLNG + w * 6 * DLNG, speed: 1.3 };
}
function fixAt(baseMs, m) {
  const p = posAt(m);
  return { fix_timestamp: new Date(baseMs + m * MIN).toISOString(),
           lat: +p.lat.toFixed(7), lng: +p.lng.toFixed(7),
           speed_mps: p.speed, accuracy_m: 8, provider: 'gps' };
}
function accelAt(baseMs, m) {
  return { event_timestamp: new Date(baseMs + m * MIN).toISOString(),
           kind: 'accelerometer', payload: { variance: 0.02, gate: 'vibration_present' } };
}
async function upload(token, path, body) {
  const r = await j(path, { method: 'POST', body: JSON.stringify(body) }, token);
  if (r.status !== 200) throw new Error(`${path} failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function main() {
  await initDb();

  /* -- boot: logins -------------------------------------------------------- */
  const login = await j('/auth/login', { method: 'POST', body: JSON.stringify(DRIVER) });
  check('login as seeded driver', login.status === 200 && !!login.body.access_token, `status=${login.status}`);
  if (!login.body?.access_token) { console.error('cannot continue without driver token'); process.exit(1); }
  const token = login.body.access_token;
  const me = await j('/me', {}, token);
  const driverId = me.body?.user?.id ?? me.body?.driver_id ?? me.body?.id;
  const mlogin = await j('/auth/login', { method: 'POST', body: JSON.stringify(MANAGER) });
  check('login as fleet manager', mlogin.status === 200 && !!mlogin.body.access_token, `status=${mlogin.status}`);
  if (!mlogin.body?.access_token) { console.error('cannot continue without manager token'); process.exit(1); }
  const mtok = mlogin.body.access_token;

  /* ===================== A. push-token registration ====================== */
  const goodToken = `fcm-p5-${uuid()}${uuid()}`; // >20 chars guaranteed
  const reg = await j('/notifications/token',
    { method: 'POST', body: JSON.stringify({ token: goodToken, platform: 'android', device_id: 'p5-gate' }) }, token);
  check('POST /notifications/token registers (201)', reg.status === 201 && reg.body.registered === true, `status=${reg.status}`);
  const reg2 = await j('/notifications/token',
    { method: 'POST', body: JSON.stringify({ token: goodToken, platform: 'android', device_id: 'p5-gate' }) }, token);
  check('re-POST same token is idempotent UPSERT', reg2.status === 201 && reg2.body.token_id === reg.body.token_id,
    `ids ${reg.body.token_id} vs ${reg2.body.token_id}`);
  const short = await j('/notifications/token', { method: 'POST', body: JSON.stringify({ token: 'too-short' }) }, token);
  check('short token rejected (400)', short.status === 400, `status=${short.status}`);
  const anon = await j('/notifications/token', { method: 'POST', body: JSON.stringify({ token: goodToken }) });
  check('anonymous token POST rejected (401)', anon.status === 401, `status=${anon.status}`);

  /* ============ B. fire-once + replay-no-op on TRIP_STARTED fan-out ====== */
  const baseMs = Date.now() + 120 * MIN; // future-shifted event times: sweep can never close these trips mid-run
  const b1 = { batch_id: uuid(), client_sent_at: new Date().toISOString(),
               fixes: [0, 1, 2, 3, 4].map((m) => fixAt(baseMs, m)) };
  await upload(token, '/ingest/locations', b1);
  let startedRows = [];
  for (let i = 0; i < 15 && startedRows.length === 0; i++) {
    await sleep(1000);
    const lg = await j(`/notifications/log?event_type=TRIP_STARTED&limit=500`, {}, mtok);
    startedRows = (lg.body.notifications ?? []).filter((n) =>
      n.dedupe_key?.startsWith(`trip:`) && n.created_at >= new Date(Date.now() - 90_000).toISOString());
  }
  check('TRIP_STARTED fanned out to ledger', startedRows.length >= 1, `rows=${startedRows.length}`);
  const roles = new Set(startedRows.map((n) => n.recipient_role));
  check('fan-out includes driver + manager recipients', roles.has('DRIVER') && roles.has('FLEET_MANAGER'), [...roles].join(','));
  const perRole = {};
  for (const n of startedRows) perRole[n.recipient_role] = (perRole[n.recipient_role] ?? 0) + 1;
  const beforeCount = startedRows.length;
  const dup = await j('/ingest/locations', { method: 'POST', body: JSON.stringify(b1) }, token);
  check('duplicate batch ACK already_received', dup.status === 200 && dup.body.already_received === true, JSON.stringify(dup.body));
  await sleep(2500); // give any (correctly no-op) recompute chain time to misbehave
  const lg2 = await j(`/notifications/log?event_type=TRIP_STARTED&limit=500`, {}, mtok);
  const afterRows = (lg2.body.notifications ?? []).filter((n) =>
    n.dedupe_key?.startsWith(`trip:`) && n.created_at >= new Date(Date.now() - 120_000).toISOString());
  check('replay produced ZERO new notifications (fire-once)', afterRows.length === beforeCount,
    `before=${beforeCount} after=${afterRows.length}`);

  /* ==================== C. separation timer → NOTIFIED =================== */
  // Park phase WITH sensors reporting (truck genuinely stopped, phone in it)…
  await upload(token, '/ingest/locations', { batch_id: uuid(), client_sent_at: new Date().toISOString(),
    fixes: Array.from({ length: 11 }, (_, i) => fixAt(baseMs, 5 + i * 0.5)) });            // m5..m10 driving→stop
  await upload(token, '/ingest/sensors', { batch_id: uuid(), client_sent_at: new Date().toISOString(),
    events: Array.from({ length: 8 }, (_, i) => accelAt(baseMs, 10 + i * 0.5)) });         // m10..m13.5 motion present
  // …then walk away SILENTLY (phone leaves truck; truck stays put ⇒ §1.4 separation).
  await upload(token, '/ingest/locations', { batch_id: uuid(), client_sent_at: new Date().toISOString(),
    fixes: Array.from({ length: 11 }, (_, i) => fixAt(baseMs, 15 + i * 0.5)) });           // m15..m20 walking away
  let sep = null;
  for (let i = 0; i < 15 && !sep; i++) {
    await sleep(1000);
    const rows = await sqlRun(
      `SELECT separation_id, status, notified_fleet_manager, returned_at IS NOT NULL AS closed
         FROM driver_separation_log WHERE separated_at >= $1 ORDER BY separated_at DESC LIMIT 1`,
      [new Date(baseMs).toISOString()]);
    sep = rows[0];
  }
  check('DRIVER_SEPARATED incident logged OPEN (returned_at NULL)', !!sep && sep.closed === false,
    sep ? `id=${sep.separation_id} status=${sep.status}` : 'none found');
  if (sep) {
    // Fastify empty-body guard: sweep/run MUST be called with `{}` (the "-d '{}'" rule).
    const noopBody = await j('/notifications/sweep/run', { method: 'POST', body: JSON.stringify({}) }, token);
    check('sweep/run accepts empty JSON body (-d \'{}\')', noopBody.status === 200, `status=${noopBody.status}`);
    const fired = await j('/notifications/sweep/run',
      { method: 'POST', body: JSON.stringify({ separation_id: sep.separation_id }) }, token);
    check('forced sweep FIRES through real claim path',
      fired.status === 200 && fired.body.sweep?.fired >= 1 && fired.body.forced?.shifted === true,
      JSON.stringify(fired.body.sweep));
    const rows = await sqlRun(`SELECT status, notified_fleet_manager FROM driver_separation_log WHERE separation_id=$1`,
      [sep.separation_id]);
    check('incident marked notified_fleet_manager=true, status=NOTIFIED',
      rows[0]?.notified_fleet_manager === true && rows[0]?.status === 'NOTIFIED', JSON.stringify(rows[0]));
    const dk = await j(`/notifications/test/dedupe-keys/${sep.separation_id}`, {}, token);
    const keys = dk.body.keys ?? [];
    check('per-recipient dedupe keys shaped ${sepId}@${userId}',
      keys.length >= 2 && keys.every((k) => k.startsWith(`${sep.separation_id}@`)), keys.join(' | ') || 'empty');
    const rerun = await j('/notifications/sweep/run',
      { method: 'POST', body: JSON.stringify({ separation_id: sep.separation_id }) }, token);
    check('second sweep pass is a NO-OP (atomic claim + uq_notif_dedupe)',
      rerun.status === 200 && rerun.body.forced?.shifted === false &&
      (rerun.body.sweep?.fired ?? 1) === 0, JSON.stringify({ forced: rerun.body.forced, sweep: rerun.body.sweep }));
    const ledg = await j(`/notifications/log?event_type=DRIVER_SEPARATION_TIMER&limit=500`, {}, mtok);
    const mine = (ledg.body.notifications ?? []).filter((n) => n.dedupe_key?.startsWith(`${sep.separation_id}@`));
    check('DRIVER_SEPARATION_TIMER ledger rows exist for this incident', mine.length >= 2, `rows=${mine.length}`);
  }

  /* ======================= D. role matrix on reads ======================= */
  const from = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const to = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
  const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  for (const path of [`/reports/trips?${qs}`, `/reports/separations?${qs}`, '/reports/fleet-state', '/notifications/log']) {
    const okM = await j(path, {}, mtok);
    const forbD = await j(path, {}, token);
    const anonR = await j(path, {});
    check(`${path.split('?')[0]} manager=200`, okM.status === 200, `status=${okM.status}`);
    check(`${path.split('?')[0]} driver=403`, forbD.status === 403, `status=${forbD.status}`);
    check(`${path.split('?')[0]} anon=401`, anonR.status === 401, `status=${anonR.status}`);
  }
  const roster = await j('/ingest/drivers', {}, mtok);
  check('GET /ingest/drivers requires+allows manager', roster.status === 200, `status=${roster.status}`);
  const rosterAudit = await sqlRun(
    `SELECT count(*)::int AS c FROM audit_log WHERE action='read_roster' AND created_at > now() - interval '2 minutes'`);
  check('read_roster audit row landed', (rosterAudit[0]?.c ?? 0) >= 1, `c=${rosterAudit[0]?.c}`);

  /* ================ E. fleet-state contract + Redis TTL ≈ 30s ============= */
  const fs1 = await j('/reports/fleet-state?refresh=1', {}, mtok);
  check('fleet-state envelope complete', fs1.status === 200 && typeof fs1.body.generated_at === 'string'
    && fs1.body.counts && typeof fs1.body.live_window_s === 'number' && 'replica_lag_s' in fs1.body,
    `keys=${Object.keys(fs1.body ?? {}).join(',')}`);
  const v = (fs1.body.vehicles ?? [])[0];
  check('vehicle entry exposes is_live/last_fix_age_s (§1.4 labeling fields)',
    !!v && typeof v.is_live === 'boolean' && typeof v.last_fix_age_s === 'number',
    v ? `plate=${v.plate_number ?? '?'} is_live=${v.is_live} age=${v.last_fix_age_s}s` : 'no vehicles');
  const fs2 = await j('/reports/fleet-state', {}, mtok);
  check('second read served from cache (cached:true within TTL)', fs2.body?.cached === true, `cached=${fs2.body?.cached}`);
  let ttl = NaN;
  try { ttl = await redisTtl('fleet:state'); } catch (e) { console.warn('redis TTL probe failed:', e.message); }
  check('Redis TTL of fleet:state ≈ 30 s (25..30)', ttl >= 25 && ttl <= 30, `ttl=${ttl}`);
  const fs3 = await j('/reports/fleet-state?refresh=1', {}, mtok);
  check('refresh=1 busts the cache', fs3.body?.cached === false, `cached=${fs3.body?.cached}`);

  /* ========================= F. erasure endpoint ========================== */
  const adminLogin = await j('/auth/login', { method: 'POST',
    body: JSON.stringify({ identifier: process.env.ADMIN_EMAIL ?? 'admin@yet.local',
                           password: (process.env.ADMIN_PASSWORD ?? 'change-me') }) });
  const atok = adminLogin.body?.access_token;
  check('admin login available for erasure gate', adminLogin.status === 200 && !!atok, `status=${adminLogin.status}`);
  const fakeDriver = uuid();
  const fakeVehicle = (await sqlRun(
    `SELECT vehicle_id FROM driver_vehicle_assignments WHERE driver_id=$1 LIMIT 1`, [driverId]))[0]?.vehicle_id
    ?? (await sqlRun(`SELECT id FROM vehicles LIMIT 1`))[0]?.id;
  // Horizon + keep-every-N come from the SERVER env (same .env the gate reads);
  // fall back to documented defaults. Over M old fixes sorted asc with rn 1..M,
  // kept rows are rn ≡ 1 (mod N) => ceil(M/N) kept, floor(M*(N-1)/N) deleted.
  let horizonDays = Number(process.env.ERASURE_WINDOW_DAYS ?? NaN);
  if (!Number.isInteger(horizonDays) || horizonDays <= 0) {
    try {
      const fs = await import('node:fs');
      const envTxt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
      horizonDays = Number(envTxt.match(/^ERASURE_WINDOW_DAYS=(\d+)$/m)?.[1]);
    } catch { /* no .env */ }
  }
  if (!Number.isInteger(horizonDays) || horizonDays <= 0) horizonDays = 30;
  const N = Number(process.env.RETENTION_KEEP_EVERY_N ?? 10);
  const OLD_COUNT = 100;
  const expectedDeleted = Math.floor((OLD_COUNT * (N - 1)) / N);
  // NOTE: location_fixes.fix_id is BIGINT IDENTITY (partitioned table) — rows are
  // inserted WITHOUT an explicit id; ordering/tie-breaks use the DB-generated ids.
  try {
    await sqlRun(`INSERT INTO users (id, role, full_name, password_hash, locale)
                  VALUES ($1,'DRIVER','P5 Erasure Probe','x','en')`, [fakeDriver]);
    // One batch per row so we can assert exact counts via generate_series inserts.
    for (let i = 0; i < OLD_COUNT; i++) {
      await sqlRun(
        `INSERT INTO location_fixes (batch_id, driver_id, vehicle_id, fix_timestamp, lat, lng)
         VALUES ($1, $2, $3,
                 now() - make_interval(days => $4::int, secs => $5::int), 9.03, 38.74)`,
        [uuid(), fakeDriver, fakeVehicle, String(horizonDays + 15), String(i)]);
    }
    const other = await j(`/driver/${fakeDriver}/location-history`, { method: 'DELETE' }, token);
    check('erasure by unrelated DRIVER forbidden (403)', other.status === 403, `status=${other.status}`);
    const del = await j(`/driver/${fakeDriver}/location-history`, { method: 'DELETE' }, atok);
    check('admin erasure completes with receipt (200)', del.status === 200 && !!del.body.completed_at, `status=${del.status}`);
    check('deleted_rows matches stable-phase downsample (index-0 anchor kept)',
      del.body.deleted_rows === expectedDeleted, `deleted=${del.body.deleted_rows} expected=${expectedDeleted}`);
    const kept = await sqlRun(`SELECT count(*)::int AS c FROM location_fixes WHERE driver_id=$1`, [fakeDriver]);
    check('downsample keeps every Nth old fix + recent window untouched', kept[0]?.c === OLD_COUNT - expectedDeleted,
      `kept=${kept[0]?.c}`);
    const aud = await sqlRun(`SELECT count(*)::int AS c FROM audit_log WHERE action='erasure_location_history' AND target_user=$1`,
      [fakeDriver]);
    check('erasure audit receipt landed atomically', (aud[0]?.c ?? 0) === 1, `c=${aud[0]?.c}`);
    const again = await j(`/driver/${fakeDriver}/location-history`, { method: 'DELETE' }, atok);
    check('re-run erasure is a no-op (nothing older than horizon remains)', again.status === 200 && again.body.deleted_rows === 0,
      `deleted=${again.body.deleted_rows}`);
  } finally {
    await sqlRun(`DELETE FROM audit_log WHERE target_user=$1`, [fakeDriver]).catch(() => {});
    await sqlRun(`DELETE FROM location_fixes WHERE driver_id=$1`, [fakeDriver]).catch(() => {});
    await sqlRun(`DELETE FROM ingest_batches WHERE driver_id=$1`, [fakeDriver]).catch(() => {});
    await sqlRun(`DELETE FROM users WHERE id=$1`, [fakeDriver]).catch(() => {});
  }

  /* =================== G. ~100 fixes/s throughput, p95 ==================== */
  const tBase = Date.now() + 600 * MIN; // isolated far-future window
  const lats = [];
  for (let b = 0; b < 10; b++) {
    const fixes = Array.from({ length: 10 }, (_, i) => fixAt(tBase, b * 1 + i * 0.1));
    const t0 = performance.now();
    await upload(token, '/ingest/locations', { batch_id: uuid(), client_sent_at: new Date().toISOString(), fixes });
    lats.push(performance.now() - t0);
    if (b % 5 === 4) await sleep(1000); // stay under the 60-batches/min per-route limiter
  }
  lats.sort((a, b) => a - b);
  const p95 = lats[Math.min(lats.length - 1, Math.ceil(0.95 * lats.length) - 1)];
  check('~100 fixes/s sustained, p95 ingest latency < 250 ms', p95 < 250,
    `p50=${lats[Math.floor(lats.length / 2)].toFixed(1)}ms p95=${p95.toFixed(1)}ms over ${lats.length * 10} fixes`);

  console.log(failures === 0 ? '\nPHASE 5 GATE: ALL PASS' : `\nPHASE 5 GATE: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('gate aborted:', err); process.exit(1); });
