#!/usr/bin/env node
/**
 * Phase 5 performance scaffolding — TILE RENDER probe (§1.9.3: tiles must be
 * fast enough that the map is interactive on first pan; nginx edge-caches
 * /tiles/ for 24 h per infra/nginx.conf `proxy_cache_valid 200 24h`).
 *
 * Method (no auth — tiles are public raster, matching the dashboard's
 * <img> loading which cannot attach JWTs):
 *   1) COLD leg: request M distinct z/x/y tiles around Addis Ababa at zoom 11
 *      through the tile endpoint. First sighting ⇒ origin fetch (tileserver-gl
 *      or placeholder). Assert 200 + image content-type; time full download
 *      (that IS the browser render cost for an <img>). Budget TILE_COLD_MS
 *      default 400 ms p95 locally.
 *   2) WARM leg: re-request the SAME tiles ⇒ nginx cache HIT expected; budget
 *      TILE_WARM_MS default 80 ms p95. Cache-hit status is inferred from the
 *      `x-cache` header when present (nginx adds it only if configured to —
 *      absence is reported as INFO, never faked).
 *
 * Endpoint resolution order (first that answers /healthz-style GET wins):
 *   TILE_BASE_URL env → BASE_URL + '/tiles' (via nginx/gateway) → :8082/tiles
 *   (vite dev proxy target, web-dashboard/vite.config.ts). A non-200 on the
 *   chosen base fails the run loudly with guidance to start the tiles profile:
 *   docker compose -f infra/docker-compose.yml --profile tiles up -d tiles
 *
 * Usage:
 *   [TILE_BASE_URL=http://localhost/tiles | BASE_URL=http://127.0.0.1:3000] \
 *   [M=40] [TILE_COLD_MS=400] [TILE_WARM_MS=80] node scripts/perf/tile_render.mjs
 */
const CANDIDATES = [
  process.env.TILE_BASE_URL,
  `${process.env.BASE_URL ?? 'http://127.0.0.1:3000'}/tiles`,
  'http://127.0.0.1:8082/tiles',
].filter(Boolean);
const M = Number(process.env.M ?? 40);
const COLD_BUDGET = Number(process.env.TILE_COLD_MS ?? 400);
const WARM_BUDGET = Number(process.env.TILE_WARM_MS ?? 80);

const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

// Deterministic tile set: zoom 11 grid covering Addis Ababa (x≈486-490, y≈292-296
// slippy coords for 9.0N 38.7E). Seeded jitter keeps runs reproducible.
function tileList(n) {
  let s = 7;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [];
  for (let i = 0; i < n; i++) {
    const z = 11;
    out.push({ z, x: 486 + Math.floor(rnd() * 5), y: 292 + Math.floor(rnd() * 5) });
  }
  return out;
}

async function timedGet(url) {
  const t0 = performance.now();
  let res = null;
  try { res = await fetch(url, { signal: AbortSignal.timeout(10000) }); } catch { return { ms: performance.now() - t0, status: 0, ct: null, xcache: null }; }
  const buf = await res.arrayBuffer(); // full download = browser <img> cost
  return { ms: performance.now() - t0, status: res.status, bytes: buf.byteLength, ct: res.headers.get('content-type'), xcache: res.headers.get('x-cache') };
}

// Probe candidates: pick the first base that returns a valid PNG/JPEG tile.
let base = null;
for (const c of CANDIDATES) {
  const r = await timedGet(`${c}/11/488/294.png`);
  if (r.status === 200 && /image\//.test(r.ct ?? '')) { base = c; console.log(`INFO tile endpoint: ${c} (${r.ct}, ${r.bytes}B, ${r.ms.toFixed(0)}ms warm-up)`); break; }
  console.error(`INFO candidate ${c} not usable (status=${r.status} ct=${r.ct})`);
}
if (!base) {
  console.error('FAIL no tile endpoint responded with an image.');
  console.error('Start the self-hosted tile server: docker compose -f infra/docker-compose.yml --profile tiles up -d tiles');
  console.error('(or point TILE_BASE_URL at whatever serves Leaflet URL template /tiles/{z}/{x}/{y}.png)');
  process.exit(1);
}

const tiles = tileList(M);
const cold = [];
const badCt = [];
for (const t of tiles) {
  const r = await timedGet(`${base}/${t.z}/${t.x}/${t.y}.png`);
  if (r.status !== 200 || !/image\//.test(r.ct ?? '')) badCt.push(`${t.z}/${t.x}/${t.y} -> ${r.status}/${r.ct}`);
  cold.push(r.ms);
}
const warm = [];
let hitsObserved = 0, xcacheSeen = 0;
for (const t of tiles) {
  const r = await timedGet(`${base}/${t.z}/${t.x}/${t.y}.png`);
  warm.push(r.ms);
  if (r.xcache) { xcacheSeen++; if (/hit/i.test(r.xcache)) hitsObserved++; }
}

let fail = false;
if (badCt.length) { fail = true; console.log(`FAIL ${badCt.length}/${M} tiles not served as images (e.g. ${badCt[0]})`); }
const cp = p95(cold), wp = p95(warm);
const chk = (name, v, budget) => { const ok = v <= budget; fail = fail || !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name} p95=${v.toFixed(1)}ms (budget ${budget}ms)`); };
chk('tile cold render (first fetch)', cp, COLD_BUDGET);
chk('tile warm render (edge cache)', wp, WARM_BUDGET);
console.log(xcacheSeen
  ? `INFO nginx x-cache observed on ${xcacheSeen}/${M} warm requests, HIT on ${hitsObserved}`
  : 'INFO no x-cache header (nginx add_header not enabled) — warm timing is the cache proxy, label baselines accordingly');
console.log(fail ? 'TILE RENDER: FAIL' : 'TILE RENDER: OK');
process.exit(fail ? 1 : 0);
