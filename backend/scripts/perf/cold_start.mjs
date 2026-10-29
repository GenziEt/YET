#!/usr/bin/env node
/**
 * Phase 5 performance scaffolding — COLD START probe (§1.9 roadmap metric).
 *
 * Measures the worst realistic "phone-at-the-truck-stop, app just opened"
 * latency chain on a LIVE stack:
 *   login (fresh JWT) → first authenticated map-critical read
 * The dashboard's cold path is exactly this: no warm token cache, then it
 * immediately asks for fleet state (which populates the map + panels). We
 * therefore time two classes:
 *   A. POST /auth/login            — budget LOGIN_BUDGET_MS (default 1200 ms;
 *      includes bcrypt verify — the dominant cold cost, §1.9 CI margin)
 *   B. GET /reports/fleet-state    — FIRST call after login, i.e. potentially
 *      cache-missed (refresh flag NOT set; we accept whatever the server
 *      returns but report the `cached` discriminator honestly). Budget
 *      FLEET_BUDGET_MS default 800 ms locally.
 *
 * Iterations are interleaved with an optional cooldown so each sample sees a
 * cold-ish auth path (token cache TTLs in Redis cannot be purged remotely
 * without admin keys; cooldown approximates it and is documented, not hidden).
 *
 * Requires a live non-prod backend + valid credentials (same fixture env vars
 * as route_p95.mjs / report_p95.mjs). Fails loudly when unreachable.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 MANAGER_EMAIL=... MANAGER_PASSWORD=... \
 *   [N=10] [COOLDOWN_MS=2000] [LOGIN_BUDGET_MS=1200] [FLEET_BUDGET_MS=800] \
 *   node scripts/perf/cold_start.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const N = Number(process.env.N ?? 10);
const COOLDOWN = Number(process.env.COOLDOWN_MS ?? 2000);
const LOGIN_BUDGET = Number(process.env.LOGIN_BUDGET_MS ?? 1200);
const FLEET_BUDGET = Number(process.env.FLEET_BUDGET_MS ?? 800);

const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timed(fn) {
  const t0 = performance.now();
  const res = await fn();
  const ms = performance.now() - t0;
  let body = null; try { body = await res.json(); } catch {}
  return { ms, status: res.status, body };
}

// Pre-flight: stack must be up or we fail loudly (never silently SKIP a gate).
let ping;
try {
  ping = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(5000) });
} catch (e) {
  console.error(`FAIL backend unreachable at ${BASE}: ${e.message}`);
  console.error('Start the dev stack first: docker compose -f infra/docker-compose.yml up -d');
  process.exit(1);
}
if (!ping.ok) { console.error(`FAIL /healthz returned ${ping.status}`); process.exit(1); }

const logins = [];
const fleets = [];
let cachedHits = 0;

for (let i = 0; i < N; i++) {
  if (i > 0 && COOLDOWN > 0) await sleep(COOLDOWN);
  const l = await timed(() => fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: process.env.MANAGER_EMAIL, password: process.env.MANAGER_PASSWORD }),
  }));
  if (l.status !== 200 || !(l.body?.token ?? l.body?.access_token)) {
    console.error(`FAIL login iteration ${i + 1}: ${l.status} ${JSON.stringify(l.body)?.slice(0, 160)}`);
    console.error('Set MANAGER_EMAIL / MANAGER_PASSWORD to seeded dev credentials.');
    process.exit(1);
  }
  logins.push(l.ms);
  const token = l.body.token ?? l.body.access_token;
  const f = await timed(() => fetch(`${BASE}/reports/fleet-state`, {
    headers: { authorization: `Bearer ${token}` },
  }));
  if (f.status !== 200) { console.error(`FAIL fleet-state iteration ${i + 1}: ${f.status}`); process.exit(1); }
  fleets.push(f.ms);
  if (f.body?.cached === true) cachedHits++;
  process.stderr.write(`  sample ${i + 1}/${N}: login=${l.ms.toFixed(0)}ms fleet=${f.ms.toFixed(0)}ms${f.body?.cached ? ' (cached)' : ''}\n`);
}

const lp = p95(logins), fp = p95(fleets);
const totalP95 = p95(logins.map((_, i) => logins[i] + fleets[i]));
let fail = false;
const check = (name, v, budget) => { const ok = v <= budget; fail = fail || !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name} p95=${v.toFixed(1)}ms (budget ${budget}ms)`); };
check('cold-start login', lp, LOGIN_BUDGET);
check('cold-start fleet-state-first-read', fp, FLEET_BUDGET);
console.log(`INFO end-to-end cold sequence (login+first read) p95=${totalP95.toFixed(1)}ms`);
console.log(`INFO fleet-state cache-hit ratio across run: ${cachedHits}/${N} (low ratio ⇒ reads genuinely cold — expected for this probe)`);
console.log(fail ? 'COLD START: FAIL' : 'COLD START: OK');
process.exit(fail ? 1 : 0);
