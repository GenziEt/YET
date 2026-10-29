#!/usr/bin/env node
/**
 * Phase 5 performance scaffolding — UPLOAD INTEGRITY probe (§1.8.2/§1.8.3 +
 * §1.9.1 upload-latency pilot metric). Two classes, one script:
 *
 *  A. REPLAY INTEGRITY (correctness): POST a batch with a fresh UUID batch_id,
 *     count rows landed; re-POST the byte-identical body ⇒ response must carry
 *     already_received:true AND the row count for that batch_id must NOT move
 *     (backed by idx_fixes_batch / uq_fixes_batch_time). This is the property
 *     the offline-first driver app depends on when it re-drains after ACK loss.
 *
 *  B. UPLOAD LATENCY (performance): fixes are stamped client_sent_at = now()
 *     at send time; server stores received_at. Skew = received_at −
 *     client_sent_at per row; p95 must stay ≤ 2000 ms locally (CI margin over
 *     the §1.9.1 budget; field runs over 3G will differ — hence env-tunable).
 *
 * Requires a LIVE non-prod backend with an authorized DRIVER token whose fleet
 * has consent ON (same fixture assumptions as integration-ingest.mjs).
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3199 DATABASE_URL=postgres://... \
 *   DRIVER_IDENTIFIER=+251900000001 DRIVER_PASSWORD=dev-driver-secret \
 *   [P95_BUDGET_MS=2000] node --import tsx scripts/perf/upload_integrity.mjs
 */
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3199';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://yet:change-me@127.0.0.1:5432/yet';
const BUDGET = Number(process.env.P95_BUDGET_MS ?? 2000);
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

let sqlRun = null;
async function initDb() {
  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    sqlRun = async (text, params) => (await client.query(text, params)).rows;
  } catch {
    const { execSync } = await import('node:child_process');
    sqlRun = (text) => {
      execSync(`psql ${JSON.stringify(DB_URL)} -X -q -c ${JSON.stringify(text)}`, { encoding: 'utf8' });
      return [];
    };
    console.error('WARN pg unavailable — integrity counts degrade to response-body checks only');
  }
}

async function j(path, opts = {}, token) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(opts.headers ?? {}) },
  });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

await initDb();
const login = await j('/auth/login', { method: 'POST', body: JSON.stringify({
  identifier: process.env.DRIVER_IDENTIFIER ?? '+251900000001',
  password: process.env.DRIVER_PASSWORD ?? 'dev-driver-secret' }) });
if (login.status !== 200) { console.error('FAIL driver login', login.status); process.exit(1); }
const token = login.body.token ?? login.body.access_token;

// Build one batch: 10 fixes, 1 Hz cadence around Bole, client clocks stamped NOW.
const batchId = crypto.randomUUID();
const t0 = Date.now();
const fixes = Array.from({ length: 10 }, (_, i) => ({
  lat: 9.0005 + i * 0.0002, lng: 38.7965 + i * 0.0003,
  fix_timestamp: new Date(t0 + i * 1000).toISOString(),
  client_sent_at: new Date(t0 + i * 1000).toISOString(),
  accuracy_m: 8, battery_pct: 80 - i * 0.1, charging: false, network_type: 'wifi',
}));
const body = JSON.stringify({ batch_id: batchId, fixes });

// --- A. replay integrity -----------------------------------------------------
const first = await fetch(BASE + '/ingest/locations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
const firstJson = await first.json().catch(() => null);
const replay = await fetch(BASE + '/ingest/locations', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
const replayJson = await replay.json().catch(() => null);
let fail = false;
const okFirst = first.status === 200 || first.status === 202;
fail = fail || !okFirst;
console.log(`${okFirst ? 'PASS' : 'FAIL'} initial batch accepted (${first.status})`);
const sawAlready = replayJson && (replayJson.already_received === true || replayJson.already_received?.length || replayJson.duplicates != null);
fail = fail || !sawAlready;
console.log(`${sawAlready ? 'PASS' : 'FAIL'} replay flagged already_received — ${JSON.stringify(replayJson)?.slice(0, 120)}`);
if (sqlRun) {
  const [{ c }] = await sqlRun('SELECT COUNT(*)::int AS c FROM location_fixes WHERE batch_id = $1', [batchId]);
  const dup = c > fixes.length;
  fail = fail || dup;
  console.log(`${dup ? 'FAIL' : 'PASS'} row count stable after replay: ${c} (sent ${fixes.length})`);
}

// --- B. upload latency skew ---------------------------------------------------
if (sqlRun) {
  const rows = await sqlRun(
    `SELECT EXTRACT(EPOCH FROM (received_at - client_sent_at)) * 1000 AS skew_ms
       FROM location_fixes WHERE batch_id = $1 AND client_sent_at IS NOT NULL`, [batchId]);
  if (rows.length) {
    const v = p95(rows.map((r) => Number(r.skew_ms)));
    const pass = v <= BUDGET;
    fail = fail || !pass;
    console.log(`${pass ? 'PASS' : 'FAIL'} upload-latency p95=${v.toFixed(1)}ms (budget ${BUDGET}ms)`);
  } else console.log('SKIP skew read (no client_sent_at rows visible)');
}

console.log(fail ? 'UPLOAD INTEGRITY: FAIL' : 'UPLOAD INTEGRITY: OK');
process.exit(fail ? 1 : 0);
