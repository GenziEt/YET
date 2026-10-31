#!/usr/bin/env node
/**
 * Module 1 e2e smoke — driver onboarding WITHOUT login, against a running dev
 * server with OTP_DEV_ECHO=true (no SMS provider needed):
 *
 *   cd backend && npm run build && OTP_DEV_ECHO=true NODE_ENV=development \
 *     node dist/server.js &   # or: npm run dev
 *   node scripts/onboarding-smoke.mjs [BASE_URL]
 *
 * Exercises the exact contract the Flutter app uses: OTP request -> verify ->
 * ticket check -> register (no password) -> session refresh (silent re-login)
 * -> profile GET/PATCH -> document upload (mandatory licence) -> admin queue,
 * document verify, fleet move + truck assignment. Prints PASS/FAIL per step
 * and exits non-zero on the first failure. Uses SEED credentials from env
 * (ADMIN_BOOTSTRAP_EMAIL/PASSWORD) for the admin half.
 */
const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3000';

let failures = 0;
async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}: ${e.message}`);
  }
}

const j = (res) => res.json().catch(() => ({}));
async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await j(res) };
}
async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, data: await j(res) };
}

function assertStatus(r, code, what) {
  if (r.status !== code) throw new Error(`${what}: expected ${code}, got ${r.status} ${JSON.stringify(r.data)}`);
}

const phone = `+2519${String(Date.now()).slice(-8)}`; // fresh number each run
const deviceId = `smoke-${crypto.randomUUID()}`;
let driverToken = '';
let driverId = '';
let adminToken = '';
let fleetIdForMove = '';

await step('health', async () => {
  const r = await get('/healthz');
  assertStatus(r, 200, 'healthz');
  return r.data.db;
});

await step('OTP request returns dev_code (needs OTP_DEV_ECHO=true)', async () => {
  const r = await post('/auth/register/otp/request', { phone });
  assertStatus(r, 200, 'otp/request');
  if (!r.data.dev_code) throw new Error('no dev_code — start the server with OTP_DEV_ECHO=true');
  return r.data.dev_code;
});

// Re-read the code via a second request only if echoed; capture from closure:
let otpCode = '';
{
  const r = await post('/auth/register/otp/request', { phone }); // rate limit allows 5/15min
  otpCode = r.data.dev_code;
}

let regTicket = '';
await step('OTP verify issues registration ticket', async () => {
  const r = await post('/auth/register/otp/verify', { phone, code: otpCode, device_id: deviceId });
  assertStatus(r, 200, 'otp/verify');
  regTicket = r.data.registration_ticket;
  if (!regTicket) throw new Error('missing registration_ticket');
  return `${r.data.expires_in_s ?? '?'}s ticket`;
});

await step('ticket replay is rejected (one-shot)', async () => {
  const r = await post('/auth/register/otp/verify', { phone, code: otpCode, device_id: deviceId });
  if (r.status === 200) throw new Error('replay accepted!');
  return `HTTP ${r.status}`;
});

await step('register without password pairs device + issues token', async () => {
  const r = await post('/auth/register', {
    registration_ticket: regTicket,
    device_id: deviceId,
    full_name: 'Smoke Test Driver',
    phone,
    license_number: `SMOKE-${Date.now()}`,
    license_class: 'C',
    license_expiry: '2030-01-01',
    association_name: 'Ethiopian Truck Owners Assoc.',
    vehicle: { plate_number: `SMK-${String(Date.now()).slice(-6)}`, vehicle_type: 'FSR', body_type: 'HIGH_BED', ownership_status: 'HIRED' },
    trailer: { plate_number: `SMT-${String(Date.now()).slice(-6)}`, trailer_type: 'LOW_BED' },
    documents_required_note: 'DRIVING_LICENSE mandatory afterwards via /me/documents',
  }, undefined);
  if (r.status !== 200 && r.status !== 201) throw new Error(`register: ${r.status} ${JSON.stringify(r.data)}`);
  driverToken = r.data.access_token;
  driverId = r.data.driver_id ?? r.data.user?.id;
  if (!driverToken) throw new Error('no access_token in register response');
  return `driver ${driverId?.slice(0, 8)}…`;
});

await step('silent session refresh replaces login', async () => {
  const r = await post('/auth/session/refresh', { device_id: deviceId }, driverToken);
  assertStatus(r, 200, 'session/refresh');
  if (r.data.access_token) driverToken = r.data.access_token;
  return 'ok';
});

await step('unknown device cannot refresh', async () => {
  const r = await post('/auth/session/refresh', { device_id: `not-paired-${Date.now()}` }, driverToken);
  if (r.status === 200) throw new Error('unpaired device accepted!');
  return `HTTP ${r.status}`;
});

await step('GET /me/profile works with paired session', async () => {
  const r = await get('/me/profile', driverToken);
  assertStatus(r, 200, '/me/profile');
  return r.data.full_name ?? 'ok';
});

await step('mandatory DRIVING_LICENSE upload accepted; bad doc type rejected', async () => {
  const form = new FormData();
  form.append('doc_type', 'DRIVING_LICENSE');
  form.append('file', new Blob([Buffer.from('%PDF-1.4 fake licence')], { type: 'application/pdf' }), 'licence.pdf');
  const res = await fetch(`${BASE}/me/documents`, {
    method: 'POST', headers: { authorization: `Bearer ${driverToken}` }, body: form,
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`upload: ${res.status} ${JSON.stringify(await j(res))}`);
  const bad = new FormData();
  bad.append('doc_type', 'NOT_A_DOC_TYPE');
  bad.append('file', new Blob(['x'], { type: 'image/jpeg' }), 'x.jpg');
  const res2 = await fetch(`${BASE}/me/documents`, { method: 'POST', headers: { authorization: `Bearer ${driverToken}` }, body: bad });
  if (res2.status < 400) throw new Error('invalid doc_type accepted!');
  return 'ok';
});

await step('admin bootstrap login (dashboard identity is password-based)', async () => {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL ?? 'admin@yet.local';
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? 'change-me';
  const r = await post('/auth/login', { identifier: email, password });
  assertStatus(r, 200, 'admin login');
  adminToken = r.data.access_token;
  return email;
});

await step('driver appears in PENDING review queue', async () => {
  const r = await get('/admin/drivers?status=PENDING', adminToken);
  assertStatus(r, 200, '/admin/drivers');
  const found = r.data.drivers.find((d) => d.id === driverId);
  if (!found) throw new Error('smoke driver not in pending queue');
  return `${r.data.count} pending`;
});

await step('admin verifies licence doc, moves driver to a fleet, assigns truck', async () => {
  const dossier = await get(`/admin/drivers/${driverId}`, adminToken);
  assertStatus(dossier, 200, 'dossier');
  const lic = dossier.data.documents.find((d) => d.doc_type === 'DRIVING_LICENSE');
  if (!lic) throw new Error('licence doc missing in dossier');
  const patch = await fetch(`${BASE}/admin/documents/${lic.id}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status: 'VERIFIED' }),
  });
  if (patch.status !== 200) throw new Error(`doc verify: ${patch.status}`);
  const fleets = await get('/fleets', adminToken);
  assertStatus(fleets, 200, '/fleets');
  fleetIdForMove = fleets.data.fleets.find((f) => f.name !== 'Unassigned Fleet' && f.status === 'ACTIVE')?.id;
  if (fleetIdForMove) {
    const mv = await post(`/admin/drivers/${driverId}/move`, { fleet_id: fleetIdForMove }, adminToken);
    assertStatus(mv, 200, 'driver move');
  }
  const vehicles = await get('/admin/vehicles', adminToken);
  assertStatus(vehicles, 200, '/admin/vehicles');
  const veh = vehicles.data.vehicles.find((v) => v.current_driver?.driver_id === driverId)
    ?? vehicles.data.vehicles.find((v) => !v.current_driver);
  if (veh) {
    const as = await post(`/admin/drivers/${driverId}/assign-vehicle`, { vehicle_id: veh.id }, adminToken);
    assertStatus(as, 201, 'assign-vehicle');
    return `verified+moved+assigned ${veh.plate_number}`;
  }
  return 'verified (no assignable vehicle present)';
});

console.log(failures ? `\nSMOKE FAILED: ${failures} step(s)` : '\nSMOKE PASSED: all steps');
process.exit(failures ? 1 : 0);
