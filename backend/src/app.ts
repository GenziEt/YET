import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { env, isProd, validateComplianceBoot } from './config/env.js';
import { checkDb, pool } from './db/pool.js';
import identityRoutes, { ensureBootstrapAdmin, ensureSeedDevDriver } from './modules/identity/routes.js';
import onboardingRoutes from './modules/identity/onboarding.js';
import ingestRoutes from './modules/ingest/routes.js';
import tripRoutes from './modules/trip_engine/routes.js';
import osmRoutes from './modules/osm_gateway/routes.js';
import geofenceRoutes from './modules/geofence/routes.js';
import reportingRoutes from './modules/reporting/routes.js';
import notificationRoutes from './modules/notification/routes.js';
import { runCrossingEvaluator } from './modules/geofence/crossing.js';
import { setRecomputeHook, setNotifyHook } from './modules/ingest/service.js';
import { runNotificationTrigger, startSeparationSweepLoop } from './modules/notification/triggers.js';
import { startDispatcherLoop } from './modules/notification/dispatchers.js';
import { recomputeVehicleWindow } from './modules/trip_engine/service.js';

/**
 * Build the modular monolith. Each module registers under its own prefix so that
 * extraction into a service later = move the folder + mount a proxy. No module may
 * import another module's internals — only shared lib/ and db/pool (the seam).
 */
export async function buildApp() {
  // --- Phase 0 compliance gate (fail-closed) ----------------------------------
  // validateComplianceBoot() is the executable counterpart of docs/COMPLIANCE-
  // PDPP.md: secret strength + placeholder rejection, administrator-bootstrap
  // hardening, Ethiopian data-residency allowlist for primary AND replica DBs,
  // ECA controller-registration status, processor-agreement references, and the
  // breach-response contact. In production ANY error aborts boot before a socket
  // opens; in development/test the same report is surfaced as warnings so local
  // work stays possible while the contract remains unit-testable.
  const compliance = validateComplianceBoot();
  if (compliance.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('REFUSING TO START — compliance precondition failures:', compliance.errors);
    throw new Error(`compliance_boot_failed: ${compliance.errors.join('; ')}`);
  }
  for (const w of compliance.warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[compliance] ${w}`);
  }

  const app = Fastify({
    logger: {
      level: isProd ? 'info' : 'debug',
      transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    },
    trustProxy: true, // behind nginx gateway
  });

  // Machine-readable denial codes are made serialization-proof at the SOURCE:
  // guards/routes send `{error:<code>}` directly (see identity/onboarding.ts),
  // because @fastify/sensible's scoped error handler hijacks thrown Errors into
  // `{error:'Forbidden', message:<code>}` regardless of setErrorHandler order.
  // KNOWN_DENIALS is kept here as a belt-and-braces fallback for any legacy
  // throw site; Fastify has no per-request errorSerializer hook, so we cannot
  // patch serialization mid-flight — do not add code that relies on it.

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false }); // API-only; CSP applies to dashboard bundle
  await app.register(cors, { origin: isProd ? ['https://yet.et'] : true });
  await app.register(rateLimit, { global: false, keyGenerator: (req) => req.ip ?? 'unknown' });

  // --- Health (§1.5 Phase 0 deliverable) --------------------------------------
  app.get('/healthz', async (_req, reply) => {
    const db = await checkDb();
    const status = db ? 'ok' : 'degraded';
    return reply.code(db ? 200 : 503).send({
      service: 'yet-backend',
      version: '0.1.0',
      phase: 'phase-4-pilot',
      db: status,
      time: new Date().toISOString(),
    });
  });

  // Readiness for container orchestrators: fails until migrations applied & DB up.
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1 FROM users LIMIT 1'); // proves migrations ran
      return { ready: true };
    } catch {
      return reply.code(503).send({ ready: false, reason: 'migrations_not_applied' });
    }
  });

  // --- Modules (bounded contexts, §1.5) ---------------------------------------
  // Module 1: Identity & Access — mounted at BOTH /auth (login) and root (/consent, /me)
  // because routes declare their own semantic paths; encapsulation keeps it one plugin.
  await app.register(async (scope) => {
    await scope.register(identityRoutes);          // /auth/login, /consent, /me
    await scope.register(onboardingRoutes);        // /auth/register*, /auth/pair-device, /me/profile, /admin/*
  });
  await app.register(ingestRoutes);                // Module 2: Ingest — /ingest/locations, /ingest/sensors
  await app.register(tripRoutes);                  // Module 3: Trip Engine — /trips, /trips/status, /trips/:id
  await app.register(osmRoutes);                   // Module 7: OSM Gateway — /route, /geocode (Phase 3)
  await app.register(geofenceRoutes);              // Module 4: Geofence — /geofences CRUD + state (Phase 3)
  await app.register(reportingRoutes);             // Module 6: Reporting — /reports/* (Phase 4 pilot + Phase 5 reports)
  await app.register(notificationRoutes);          // Module 5: Notification — /notifications/* (Phase 5)

  // Wire the ingest → trip-engine seam (§1.5 bounded contexts): Ingest owns raw
  // storage only; after each accepted batch it fires the late-bound recompute hook
  // so Trip Engine reconstructs the affected event-time window (§1.8.3). The hook
  // is registered here (composition root), not imported by Ingest's logic modules.
  // Phase 3: the SAME seam also drives the geofence crossing evaluator — chained
  // AFTER trip reconstruction so GEOFENCE_ENTER/EXIT upserts attach to trips that
  // already exist for the window. Ingest remains trip-logic-free.
  setRecomputeHook(async ({ vehicleId, driverId, fromMs, toMs }) => {
    await recomputeVehicleWindow(vehicleId, driverId, fromMs, toMs);
    await runCrossingEvaluator({ vehicleId, driverId, fromMs, toMs });
  });

  // Phase 5 (A4): Notification trigger chained on the SAME seam via a second
  // late-binding hook (ingest awaits the recompute chain before firing it), so
  // TRIP_STARTED/TRIP_ENDED/GEOFENCE_ENTER/EXIT queueing sees freshly persisted
  // trip_events. Dedupe keys derive from stored EVENT times ⇒ replay-safe no-ops.
  setNotifyHook(async ({ vehicleId, driverId, fromMs, toMs }) => {
    await runNotificationTrigger({ vehicleId, driverId, fromMs, toMs });
  });

  // Delivery workers (in-process loops; extraction = move folder + own deployment):
  // dispatcher picks up QUEUED rows every 5 s; separation sweep applies the §1.4
  // 45-min timer decision every NOTIFY_SEPARATION_SWEEP_S seconds. Both unref'd —
  // they never hold the process open in tests.
  startDispatcherLoop();
  startSeparationSweepLoop();

  // Zod errors -> 400 instead of 500. NOTE: match by duck-typing (`issues` array)
  // rather than `err.name === 'ZodError'`: when the route module's zod instance is
  // loaded through a different specifier/registry copy than this one, the thrown
  // error arrives with a mangled constructor name and Fastify's default serializer
  // can even null out `name` — so a name-only check leaks 500s for what are really
  // validation failures (observed in dev-smoke: bad-field login returned 500).
  app.setErrorHandler((err, req, reply) => {
    const e = err as any;
    const isZod = Array.isArray(e?.issues) && (e?.name === 'ZodError' || e?.constructor?.name?.includes('Zod') || !e?.statusCode);
    if (isZod) return reply.code(400).send({ error: 'validation_failed', detail: e.issues });
    // Machine-readable denial codes take precedence over @fastify/sensible's
    // default serialization — a 403 thrown as `new Error('consent_required')`
    // would otherwise render as {error:'Forbidden', message:'consent_required'};
    // the driver app branches on `consent_required` (re-show consent screen) and
    // `fleet_suspended`; the dashboard branches on `cross_fleet_denied`.
    const KNOWN_DENIALS = ['consent_required', 'fleet_suspended', 'cross_fleet_denied',
                           'forbidden_role', 'target_not_found',
                           // Driver onboarding (no-login model): fail-closed states.
                           'account_inactive', 'account_suspended', 'unauthorized'];
    if (typeof e?.message === 'string' && KNOWN_DENIALS.includes(e.message)) {
      return reply.code(e.statusCode ?? 403).send({ error: e.message });
    }
    if (e?.statusCode === 401) return reply.code(401).send({ error: 'unauthorized' });
    req.log.error(err);
    return reply.code(e?.statusCode ?? 500).send({ error: 'internal' });
  });

  await ensureBootstrapAdmin();
  await ensureSeedDevDriver(); // dev/test only — pilot device pairing (Phase 1)
  return app;
}
