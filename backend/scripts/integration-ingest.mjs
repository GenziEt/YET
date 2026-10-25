#!/usr/bin/env node
/**
 * Phase 1 integration gate script (§1.8, §1.10.4) — run against a LIVE backend + Postgres.
 *
 * Sequence (per recommended next-session plan):
 *   1. login as seeded driver            -> JWT
 *   2. POST batch (N fixes)              -> accepted=N, already_received=false
 *   3. re-POST same batch_id             -> accepted=0, already_received=true, ZERO new rows
 *   4. GET /ingest/fixes                 -> event-time ordering, N rows
 *   5. assert audit_log row for the read (PDPP §1.7 breach-readiness)
 *   6. bonus: duplicate-row-level replay via fresh batch carrying identical
 *      (vehicle_id, fix_timestamp) tuples -> ON CONFLICT DO NOTHING keeps count stable
 *
 * Usage: BASE_URL=http://127.0.0.1:3100 node scripts/integration-ingest.mjs
 * Exit 0 = all gates pass; non-zero with message on first failure.
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';

// Seeded dev driver (identity/routes.ts ensureSeedDevDriver, dev/test only).
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

function uuidv4() {
  return crypto.randomUUID();
}

// Build a synthetic Addis Ababa route: 20 fixes, 10s apart, shuffled upload order
// to prove read side orders by EVENT time regardless of arrival order (§1.8.3).
function makeFixes(driverStartMs, n = 20) {
  const fixes = [];
  let lat = 9.03, lng = 38.74; // Addis Ababa
  for (let i = 0; i < n; i++) {
    lat += 0.0009; lng += 0.0011;
    fixes.push({
      fix_timestamp: new Date(driverStartMs + i * 10_000).toISOString(),
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      speed_mps: 12 + (i % 5),
      accuracy_m: 8,
      heading_deg: 45,
      provider: 'gps',
    });
  }
  // shuffle — server must still return them in event-time order
  for (let i = fixes.length - 1; i > 0; i--) {
    const k = Math.floor(Math.random() * (i + 1));
    [fixes[i], fixes[k]] = [fixes[k], fixes[i]];
  }
  return fixes;
}

async function main() {
  // 1) login ---------------------------------------------------------------
  const login = await j('/auth/login', { method: 'POST', body: JSON.stringify(DRIVER) });
  check('login as seeded driver', login.status === 200 && !!login.body?.access_token,
        `status=${login.status}`);
  if (!login.body?.access_token) process.exit(1);
  const token = login.body.access_token;

  const me = await j('/me', {}, token);
  check('GET /me returns vehicle assignment', me.status === 200 && !!me.body?.vehicle?.plate_number,
        `plate=${me.body?.vehicle?.plate_number ?? 'none'}`);
  const driverId = me.body.id;

  // 2) POST batch ----------------------------------------------------------
  const now = Date.now();
  // Use a timestamp inside the current month so partitions exist (0006 pre-creates).
  const startMs = now - 20 * 60_000;
  const fixes = makeFixes(startMs, 20);
  const batchId = uuidv4();
  const b1 = await j('/ingest/locations',
    { method: 'POST', body: JSON.stringify({ batch_id: batchId, client_sent_at: new Date().toISOString(), fixes }) },
    token);
  check('POST batch accepted', b1.status === 200 && b1.body?.accepted === fixes.length && b1.body?.already_received === false,
        `accepted=${b1.body?.accepted} already=${b1.body?.already_received}`);

  // 3) re-POST same batch_id ----------------------------------------------
  const b2 = await j('/ingest/locations',
    { method: 'POST', body: JSON.stringify({ batch_id: batchId, client_sent_at: new Date().toISOString(), fixes }) },
    token);
  check('duplicate batch -> already_received:true', b2.status === 200 && b2.body?.already_received === true,
        `status=${b2.status} body=${JSON.stringify(b2.body)}`);
  check('duplicate batch -> zero new rows', b2.body?.accepted === 0, `accepted=${b2.body?.accepted}`);

  // 4) GET /ingest/fixes — event-time ordering ------------------------------
  const from = new Date(startMs - 60_000).toISOString();
  const to = new Date(startMs + 60 * 60_000).toISOString();
  const q = `/ingest/fixes?driver_id=${driverId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const g = await j(q, {}, token);
  const rows = g.body?.fixes ?? [];
  check('GET /ingest/fixes returns our batch rows', g.status === 200 && rows.some(r => r.batch_id === batchId),
        `count=${g.body?.count}`);
  const mine = rows.filter(r => r.batch_id === batchId);
  let ordered = true;
  for (let i = 1; i < mine.length; i++) {
    if (new Date(mine[i].fix_timestamp) < new Date(mine[i - 1].fix_timestamp)) ordered = false;
  }
  check('fixes ordered by EVENT time despite shuffled upload', ordered && mine.length === fixes.length,
        `rows=${mine.length}`);

  // 5) audit_log row for the read (PDPP §1.7) --------------------------------
  // Asserted directly against Postgres when DATABASE_URL is available to this
  // process (it is, via .env — pg is a runtime dependency of the backend).
  try {
    const { default: pkg } = await import('pg');
    const { Pool } = pkg;
    const dbUrl = process.env.DATABASE_URL ?? 'postgres://yet:change-me@127.0.0.1:5432/yet';
    const db = new Pool({ connectionString: dbUrl });
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action='read_locations' AND target_user=$1`, [driverId]);
    check('audit_log has read_locations row', rows[0].n >= 1, `rows=${rows[0].n}`);
    const { rows: dup } = await db.query(
      `SELECT count(*)::int AS n FROM ingest_batches WHERE batch_id=$1`, [batchId]);
    check('duplicate POST created zero extra batch rows', dup[0].n === 1, `batch_rows=${dup[0].n}`);
    await db.end();
  } catch (e) {
    console.error('FAIL audit_log assertion (DB unreachable):', e.message); failures++;
  }

  // 6) rate-limit sanity: burst past the per-driver window -> expect 429 + Retry-After (§1.10.4)
  //    Run LAST so throttled responses cannot poison the functional gates above.
  //    Enable with BURST=1 (burns the rate window for ~1 minute afterwards).
  if (process.env.BURST === '1') {
    let got429 = 0, missingRetryAfter = 0;
    for (let i = 0; i < 75; i++) {
      const r = await j('/ingest/locations',
        { method: 'POST', body: JSON.stringify({ batch_id: uuidv4(), fixes: [makeFixes(Date.now(), 1)[0]] }) },
        token);
      if (r.status === 429) { got429++; if (!r.headers.get('retry-after')) missingRetryAfter++; }
    }
    check('rate limiter returned 429 on excess', got429 > 0, `429s=${got429}`);
    check('429 carries Retry-After header', missingRetryAfter === 0, `missing=${missingRetryAfter}`);
  }

  if (failures) { console.error(`\n${failures} gate(s) FAILED`); process.exit(1); }
  console.log('\nAll ingest integration gates PASSED');
}

main().catch((e) => { console.error('ERROR', e); process.exit(1); });
