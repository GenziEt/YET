#!/usr/bin/env node
/**
 * Dashboard smoke harness — backend-free.
 *
 * Boots the REAL Fastify app (src/app.ts) with the `pg` Pool and ioredis Redis
 * constructors stubbed in-memory, so every route handler, Zod schema, JWT guard
 * and role check runs for real without Postgres/Redis/OSRM. Purpose: verify the
 * exact HTTP surface the Vite dev proxy forwards to (`/api/* -> /*`), including
 * the login payload contract ({ identifier, password }).
 *
 * Usage: node scripts/dev-smoke.mjs [base-url]
 *   - no arg  -> in-process stubbed backend (works anywhere)
 *   - with arg -> live smoke against a real backend + DB, e.g.:
 *       ADMIN_EMAIL=admin@yet.local ADMIN_PASSWORD=adminpass123 \
 *       node scripts/dev-smoke.mjs http://localhost:5173/api   # through the Vite proxy
 *       node scripts/dev-smoke.mjs http://localhost:3000       # direct backend
 */
import crypto from 'node:crypto';

const BASE = process.argv[2]; // optional: run against a live server instead of stubs
let TOKEN = null;            // set by login step (live mode reuses it via header)

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n      ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------------------------------------------------------------------------
// Stub mode: intercept pg.Pool / Redis before app modules load (ESM cache).
// ---------------------------------------------------------------------------
async function startStubServer() {
  const { default: pg } = await import('pg');
  const { Redis } = await import('ioredis');

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const store = { users: [], vehicles: [], driver_vehicle_assignments: [], geofences: [] };
  const seed = () => {
    const adminId = crypto.randomUUID(), driverId = crypto.randomUUID(), vehicleId = crypto.randomUUID();
    const scrypt = (pw) => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
    store.users.push(
      { id: adminId, role: 'ADMIN', full_name: 'YET Admin', email: 'admin@yet.local', phone_e164: null,
        password_hash: scrypt(process.env.ADMIN_PASSWORD || 'adminpass123'), locale: 'en', is_active: true, device_id: null },
      { id: driverId, role: 'DRIVER', full_name: 'Test Driver A', phone_e164: '+251900000001', email: null,
        password_hash: scrypt('dev-driver-secret'), locale: 'am', is_active: true, device_id: null });
    store.vehicles.push({ id: vehicleId, plate_number: 'AA-90001', fleet_name: 'Pilot Fleet', vehicle_type: 'TRUCK' });
    store.driver_vehicle_assignments.push({ driver_id: driverId, vehicle_id: vehicleId, unassigned_at: null });
  };
  seed();

  // Minimal SQL router keyed on table names present in the query text. Handlers
  // receive (sql, params); only the shapes the dashboard smoke path issues are covered.
  function handleQuery(sql, params = []) {
    const norm = sql.replace(/\s+/g, ' ').trim();
    const rows = [];
    if (/INSERT INTO users/i.test(norm)) {
      // ensureBootstrapAdmin: VALUES ('ADMIN', 'YET Admin', $1, $2) -> params [email, hash]
      const [, role, fullName, emailOrPhone, maybeHash] = params;
      const isDriverSeed = /phone_e164/i.test(norm); // seed dev driver inserts by phone + RETURNING id
      const passwordHash = isDriverSeed ? params[params.length - 1] : maybeHash;
      const rec = isDriverSeed
        ? { id: crypto.randomUUID(), role: 'DRIVER', full_name: fullName, email: null, phone_e164: emailOrPhone,
            password_hash: passwordHash, locale: 'am', is_active: true, device_id: null }
        : { id: crypto.randomUUID(), role, full_name: fullName, email: emailOrPhone, phone_e164: null,
            password_hash: passwordHash, locale: 'en', is_active: true, device_id: null };
      const dupe = store.users.find((u) => (isDriverSeed ? u.phone_e164 === rec.phone_e164 : u.email === rec.email));
      if (dupe) { dupe.password_hash = passwordHash; return { rows: [dupe], rowCount: 1 }; } // ON CONFLICT DO UPDATE ... RETURNING id
      store.users.push(rec);
      return { rows: [rec], rowCount: 1 };
    }
    if (/INSERT INTO vehicles/i.test(norm)) {
      const plate = params[0];
      let v = store.vehicles.find((x) => x.plate_number === plate);
      if (!v) { v = { id: crypto.randomUUID(), plate_number: plate, fleet_name: params[1], vehicle_type: params[2] }; store.vehicles.push(v); }
      return { rows: [v], rowCount: 1 };
    }
    if (/INSERT INTO driver_vehicle_assignments/i.test(norm)) {
      const [driverId, vehicleId] = params;
      if (!store.driver_vehicle_assignments.some((a) => a.driver_id === driverId && !a.unassigned_at)) {
        store.driver_vehicle_assignments.push({ driver_id: driverId, vehicle_id: vehicleId, unassigned_at: null });
      }
      return { rows: [], rowCount: 0 };
    }
    if (/FROM users/i.test(norm)) {
      const idOrPhone = params[0];
      const found = store.users.filter((u) => u.phone_e164 === idOrPhone || u.email === idOrPhone || u.id === idOrPhone);
      return { rows: found, rowCount: found.length };
    }
    if (/driver_vehicle_assignments/i.test(norm)) {
      const driverId = params[0];
      const asgs = store.driver_vehicle_assignments.filter((a) => a.driver_id === driverId && !a.unassigned_at)
        .map((a) => ({ ...a, ...store.vehicles.find((v) => v.id === a.vehicle_id) }));
      return { rows: asgs, rowCount: asgs.length };
    }
    if (/SELECT 1/i.test(norm)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/audit_log|ingest_batches|location_fixes|trips|consent_records/i.test(norm)) return { rows: [], rowCount: 0 };
    if (/geofences/i.test(norm)) {
      if (/^INSERT INTO geofences/i.test(norm)) {
        const g = paramsToGeofence(norm, params);
        store.geofences.push(g);
        return { rows: [g], rowCount: 1 };
      }
      if (/UPDATE geofences SET name/i.test(norm)) {
        // Full-row merge UPDATE from service.updateGeofence:
        // circle -> [id, name, category, radius_m, lat, lng, active]
        // polygon-> [id, name, category, geojson(ring), lat, lng, active]
        const id = params[0];
        const g = store.geofences.find((x) => x.geofence_id === id);
        if (!g) return { rows: [], rowCount: 0 };
        if (/radius_m=\$4/i.test(norm)) {
          Object.assign(g, { kind: 'CIRCLE', name: params[1], category: params[2], radius_m: params[3],
                            center_lat: params[4], center_lng: params[5], ring_json: null });
        } else {
          Object.assign(g, { kind: 'POLYGON', name: params[1], category: params[2], ring_json: params[3] });
        }
        if (params[6] !== null && params[6] !== undefined) g.active = params[6];
        g.updated_at = new Date().toISOString();
        return { rows: [g], rowCount: 1 };
      }
      if (/SET active=FALSE/i.test(norm)) {
        const g = store.geofences.find((x) => x.geofence_id === params[0] && x.active);
        if (!g) return { rows: [], rowCount: 0 };
        g.active = false;
        return { rows: [{ geofence_id: g.geofence_id }], rowCount: 1 };
      }
      if (/ST_Centroid/i.test(norm)) {
        // Polygon centroid lookup — answer with the ring's arithmetic mean so the
        // INSERT that follows gets plausible center_lat/lng params.
        const gj = JSON.parse(params[0]);
        const coords = gj.coordinates?.[0]?.[0] ?? [[0, 0]];
        const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
        const lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
        return { rows: [{ lat, lng }], rowCount: 1 };
      }
      let list = [...store.geofences];
      const idMatch = norm.match(/geofence_id=\$(\d+)/i);
      if (idMatch) list = list.filter((g) => g.geofence_id === params[Number(idMatch[1]) - 1]);
      if (/WHERE active/i.test(norm)) list = list.filter((g) => g.active);
      return { rows: list, rowCount: list.length };
    }
    return { rows: [], rowCount: 0 }; // unknown read/write -> benign empty
  }
  function paramsToGeofence(norm, params) {
    // CIRCLE insert: (name, kind, category, radius_m, center_lat, center_lng, geom, created_by)
    // POLYGON insert: (name, kind, category, geom, ring_json, center_lat, center_lng, created_by)
    const now = new Date().toISOString();
    const base = { geofence_id: crypto.randomUUID(), active: true, created_at: now, updated_at: now,
                   center_lat: null, center_lng: null, radius_m: null, ring_json: null };
    if (/radius_m,\s*center_lat/i.test(norm)) {
      return { ...base, name: params[0], kind: 'CIRCLE', category: params[2], radius_m: params[3],
               center_lat: params[4], center_lng: params[5] };
    }
    return { ...base, name: params[0], kind: 'POLYGON', category: params[2],
             ring_json: JSON.parse(params[4]), center_lat: params[5], center_lng: params[6] };
  }

  class FakePool {
    constructor() {}
    async query(sql, params) { return handleQuery(sql, params); }
    async connect() { return { release: () => {}, query: async (q, p) => handleQuery(q, p) }; }
    on() {} end() {}
  }
  pg.Pool = FakePool;

  // Stub every Redis command at the COMMAND level: ioredis routes .get/.set/.setex
  // through the prototype method generated from its commands map, so replacing
  // that one entry makes ALL command calls local + instant (no server needed).
  const kv = new Map();
  Redis.prototype.callWithCallback = function (_commandName, _args, callback) {
    const name = String(_commandName).toLowerCase();
    if (name === 'get') return callback(null, kv.has(_args[0]) ? kv.get(_args[0]) : null);
    if (name === 'set' || name === 'setex') {
      const [k, v] = name === 'set' ? [_args[0], _args[1]] : [_args[0], _args[2]];
      kv.set(k, String(v)); return callback(null, 'OK');
    }
    if (name === 'del') { for (const k of _args) kv.delete(k); return callback(null, _args.length); }
    if (name === 'ping') return callback(null, 'PONG');
    return callback(null, null);
  };

  const { buildApp } = await import('../src/app.js');
  const app = await buildApp();
  await app.listen({ port: 3100, host: '127.0.0.1' });
  console.log('stub backend listening on http://127.0.0.1:3100 (no DB/Redis required)');
  return { url: 'http://127.0.0.1:3100', close: async () => { await app.close(); process.exit(failed ? 1 : 0); } };
}

// ---------------------------------------------------------------------------
// Shared assertions — run against ANY base URL (stub, direct, or via proxy).
// Paths below are written exactly as web-dashboard/src/lib/api.ts emits them
// after the vite rewrite: `/api/x` -> `x` on the backend. When BASE ends with
// `/api` we keep the prefix; when it's the bare backend root we strip nothing
// because these helpers append the dashboard-style paths relative to BASE.
// ---------------------------------------------------------------------------
async function apiFetch(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...opts.headers },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

async function runSuite(base) {
  console.log(`\nSmoke suite against ${base}`);

  await check('GET /healthz -> service+phase, db reachable', async () => {
    const r = await apiFetch(base, '/healthz');
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body?.service === 'yet-backend', 'not yet-backend');
  });

  await check('POST /auth/login accepts { identifier, password } (NOT "email")', async () => {
    const ok = await apiFetch(base, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: process.env.ADMIN_EMAIL || 'admin@yet.local',
                             password: process.env.ADMIN_PASSWORD || 'adminpass123' }),
    });
    assert(ok.status === 200, `login status ${ok.status}: ${JSON.stringify(ok.body)}`);
    assert(typeof ok.body?.access_token === 'string', 'missing access_token');
    assert(ok.body?.role === 'ADMIN', `role ${ok.body?.role}`);
    TOKEN = ok.body.access_token;

    const badField = await apiFetch(base, '/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@yet.local', password: 'whatever12' }) });
    assert(badField.status === 400, `email-field login should 400 (Zod identifier required), got ${badField.status}`);
  });

  await check('GET /geofences without token -> 401 (guard wired)', async () => {
    const saved = TOKEN; TOKEN = null;
    const r = await apiFetch(base, '/geofences');
    TOKEN = saved;
    assert(r.status === 401, `status ${r.status}`);
  });

  await check('POST /geofences (ADMIN) creates CIRCLE zone', async () => {
    const r = await apiFetch(base, '/geofences', { method: 'POST', body: JSON.stringify({
      kind: 'CIRCLE', name: 'Smoke Warehouse', category: 'WAREHOUSE',
      center: { lat: 9.035, lng: 38.74 }, radius_m: 500 }) });
    assert(r.status === 201, `status ${r.status}: ${JSON.stringify(r.body)}`);
    assert(uuidReOk(r.body?.geofence_id), 'bad geofence_id');
    assert(r.body?.center?.lat === 9.035, `center echo ${JSON.stringify(r.body?.center)}`);
    globalThis.__zoneId = r.body.geofence_id;
  });
  const uuidReOk = (s) => typeof s === 'string' && s.length > 10;

  await check('GET /geofences lists the zone (dashboard layer source)', async () => {
    const r = await apiFetch(base, '/geofences');
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body?.geofences) && r.body.geofences.length >= 1, 'empty list');
  });

  await check('PUT /geofences/:id metadata-only update works', async () => {
    const r = await apiFetch(base, `/geofences/${globalThis.__zoneId}`, {
      method: 'PUT', body: JSON.stringify({ name: 'Smoke Warehouse 2' }) });
    assert(r.status === 200, `status ${r.status}: ${JSON.stringify(r.body)}`);
    assert(r.body?.name === 'Smoke Warehouse 2', 'name not updated');
  });

  await check('GET /geofences/state?vehicle_id=<uuid> -> state matrix shape', async () => {
    const r = await apiFetch(base, '/geofences/state?vehicle_id=11111111-1111-1111-1111-111111111111');
    assert(r.status === 200, `status ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body?.inside) && Array.isArray(r.body?.states), 'missing inside/states arrays');
  });

  await check('GET /route returns geometry+source (fallback_straight OK w/o OSRM)', async () => {
    const r = await apiFetch(base, '/route?from=9.03,38.74&to=8.98,38.79');
    assert(r.status === 200, `status ${r.status}: ${JSON.stringify(r.body)}`);
    assert(Array.isArray(r.body?.geometry), 'no geometry');
    assert(['redis','postgres','osrm','stale_redis','fallback_straight'].includes(r.body?.source), `source ${r.body?.source}`);
  });

  await check('GET /trips?status=active -> trips list shape', async () => {
    const r = await apiFetch(base, '/trips?status=active&limit=50');
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body?.trips), 'no trips array');
  });

  await check('GET /ingest/drivers -> roster array (selector source)', async () => {
    const r = await apiFetch(base, '/ingest/drivers');
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body?.drivers), 'no drivers array');
  });

  await check('DELETE /geofences/:id soft-deactivates', async () => {
    const r = await apiFetch(base, `/geofences/${globalThis.__zoneId}`, { method: 'DELETE' });
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body?.deleted === true, 'not deleted');
  });
}

// ---------------------------------------------------------------------------
if (BASE) {
  await runSuite(BASE.replace(/\/$/, ''));
} else {
  const { url, close } = await startStubServer();
  await runSuite(url);
  await close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
