#!/usr/bin/env node
/**
 * Phase 5 performance scaffolding — REPORT p95 probe (§1.10.4 read-path budget:
 * manager report reads ≤ 500 ms p95 against the reporting window; CSV export
 * streams within the same envelope so RFC-4180 quoting never truncates).
 *
 * Hits the REAL endpoints wired in Phase 5 (reporting/routes.ts):
 *   GET /reports/trips?from&to            (+ format=csv)
 *   GET /reports/separations?from&to      (+ format=csv)
 *   GET /reports/fleet-state              (JSON + ?refresh=1 cache-bust leg)
 * Fleet scoping is fail-closed server-side; the probe authenticates as a
 * FLEET_MANAGER so it measures the production read path, not an ADMIN bypass.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 MANAGER_EMAIL=... MANAGER_PASSWORD=... \
 *   [REPEATS=25] [P95_BUDGET_MS=500] node --import tsx scripts/perf/report_p95.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const REPEATS = Number(process.env.REPEATS ?? 25);
const BUDGET = Number(process.env.P95_BUDGET_MS ?? 500);

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: process.env.MANAGER_EMAIL, password: process.env.MANAGER_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status} — set MANAGER_EMAIL/MANAGER_PASSWORD`);
  const b = await res.json();
  return b.token ?? b.access_token;
}

const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

async function timed(token, path) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();          // drain body — CSV legs must fully stream
  const ms = performance.now() - t0;
  return { ms, status: res.status, bytes: text.length, ct: res.headers.get('content-type') ?? '' };
}

const token = await login();
const to = new Date().toISOString();
const from = new Date(Date.now() - 7 * 864e5).toISOString();
const paths = [
  `/reports/trips?from=${from}&to=${to}`,
  `/reports/trips?from=${from}&to=${to}&format=csv`,
  `/reports/separations?from=${from}&to=${to}`,
  `/reports/separations?from=${from}&to=${to}&format=csv`,
  `/reports/fleet-state`,
];

let fail = false;
for (const p of paths) {
  const runs = [];
  for (let i = 0; i < REPEATS; i++) runs.push(await timed(token, p));
  const bad = runs.filter((r) => r.status !== 200);
  const okRuns = runs.filter((r) => r.status === 200);
  const lat = okRuns.map((r) => r.ms);
  const csv = p.includes('format=csv');
  const wrongCt = okRuns.filter((r) => csv && !r.ct.includes('csv')).length;
  const v = lat.length ? p95(lat) : Infinity;
  const pass = bad.length === 0 && wrongCt === 0 && v <= BUDGET;
  fail = fail || !pass;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${p.split('?')[0]}${csv ? ' [csv]' : ''}: p95=${v.toFixed(1)}ms (budget ${BUDGET}), errors=${bad.length}, wrong-content-type=${wrongCt}, avg-bytes=${Math.round(okRuns.reduce((a, r) => a + r.bytes, 0) / (okRuns.length || 1))}`);
}

// Cache-bust leg: fleet-state ?refresh=1 must still answer inside budget even
// though it skips the 30 s Redis envelope (worst-case read measured explicitly).
const bust = [];
for (let i = 0; i < 5; i++) bust.push(await timed(token, '/reports/fleet-state?refresh=1'));
const bv = p95(bust.map((r) => r.ms));
const bp = bv <= BUDGET;
fail = fail || !bp;
console.log(`${bp ? 'PASS' : 'FAIL'} /reports/fleet-state?refresh=1: p95=${bv.toFixed(1)}ms (budget ${BUDGET})`);

console.log(fail ? 'REPORT P95: FAIL' : 'REPORT P95: OK');
process.exit(fail ? 1 : 0);
