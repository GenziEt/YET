#!/usr/bin/env node
/**
 * Phase 5 performance scaffolding — ROUTE p95 probe (§1.9.4 budgets, verified
 * against osm_gateway/service.ts header comments):
 *   GET /route CACHED   ≤  50 ms  (Redis hit short-circuits everything)
 *   GET /route UNCACHED ≤ 800 ms  (OSRM call budgeted at OSRM_TIMEOUT_MS)
 *
 * Method: N unique coordinate pairs around Addis Ababa → all miss cache
 * (uncached class; requires a live OSRM behind the backend). Then repeat the
 * SAME pairs → every response must carry source:'redis' (or 'postgres' if the
 * Redis entry aged out mid-run — counted honestly, not hidden). p95 computed
 * per class; exit 1 on budget breach.
 *
 * The `source` discriminator is part of the API contract
 * ('redis'|'postgres'|'osrm'|'stale_redis'|'fallback_straight') so mislabeled
 * classes cannot silently pass the probe. fallback_straight responses are
 * counted as failures for the uncached leg (OSRM down ⇒ probe invalid, loud).
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 MANAGER_EMAIL=... MANAGER_PASSWORD=... \
 *   [N=60] node --import tsx scripts/perf/route_p95.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const N = Number(process.env.N ?? 60);

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: process.env.MANAGER_EMAIL, password: process.env.MANAGER_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status} — set MANAGER_EMAIL/MANAGER_PASSWORD`);
  return (await res.json()).token ?? (await res.json()).access_token;
}

// Deterministic pseudo-random pairs in the Addis Ababa bbox (38.6–38.9, 8.9–9.1).
function pairs(n) {
  let s = 42;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const f = (lo, hi) => (lo + rnd() * (hi - lo)).toFixed(5);
  return Array.from({ length: n }, () => ({ from: `${f(9.0, 9.03)},${f(38.7, 38.76)}`, to: `${f(8.94, 8.98)},${f(38.79, 38.84)}` }));
}

const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

async function timed(token, p) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/route?from=${p.from}&to=${p.to}`, { headers: { authorization: `Bearer ${token}` } });
  const ms = performance.now() - t0;
  const body = await res.json().catch(() => null);
  return { ms, status: res.status, source: body?.source ?? null };
}

const token = await login();
const P = pairs(N);

// Leg 1: uncached (unique pairs; first sighting of each coordinate).
const uncached = [];
for (const p of P) uncached.push(await timed(token, p));
const uOK = uncached.filter((r) => r.status === 200 && r.source === 'osrm');
const uBad = uncached.filter((r) => r.source === 'fallback_straight');
console.log(`uncached: ${uOK.length}/${N} via osrm, ${uBad.length} fallback_straight, p95=${p95(uOK.map(r => r.ms)).toFixed(1)}ms (budget 800)`);

// Leg 2: same pairs again — expect Redis hits.
const cached = [];
for (const p of P) cached.push(await timed(token, p));
const cHits = cached.filter((r) => r.source === 'redis');
const cPg = cached.filter((r) => r.source === 'postgres'); // TTL edge — labeled, not hidden
console.log(`cached:   redis ${cHits.length}, postgres ${cPg.length}, p95(redis)=${cHits.length ? p95(cHits.map(r => r.ms)).toFixed(1) : 'n/a'}ms (budget 50)`);

let fail = false;
if (uBad.length > 0) { console.error('FAIL OSRM fallback_straight responses — probe needs live routing'); fail = true; }
if (uOK.length < N * 0.9) { console.error('FAIL too few osrm-sourced uncached responses'); fail = true; }
if (uOK.length && p95(uOK.map((r) => r.ms)) > 800) { console.error('FAIL uncached p95 > 800ms'); fail = true; }
if (cHits.length && p95(cHits.map((r) => r.ms)) > 50) { console.error('FAIL cached p95 > 50ms'); fail = true; }
console.log(fail ? 'ROUTE P95: FAIL' : 'ROUTE P95: OK');
process.exit(fail ? 1 : 0);
