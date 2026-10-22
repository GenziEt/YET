import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { env, isProd } from './config/env.js';
import { checkDb, pool } from './db/pool.js';
import identityRoutes, { ensureBootstrapAdmin, ensureSeedDevDriver } from './modules/identity/routes.js';
import ingestRoutes from './modules/ingest/routes.js';

/**
 * Build the modular monolith. Each module registers under its own prefix so that
 * extraction into a service later = move the folder + mount a proxy. No module may
 * import another module's internals — only shared lib/ and db/pool (the seam).
 */
export async function buildApp() {
  const app = Fastify({
    logger: {
      level: isProd ? 'info' : 'debug',
      transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    },
    trustProxy: true, // behind nginx gateway
  });

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
      phase: 'phase-1-ingest',
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
  });
  await app.register(ingestRoutes);                // Module 2: Ingest — /ingest/locations

  // Zod errors -> 400 instead of 500
  app.setErrorHandler((err, req, reply) => {
    if ((err as any)?.name === 'ZodError') return reply.code(400).send({ error: 'validation_failed', detail: (err as any).issues });
    if ((err as any)?.statusCode === 401) return reply.code(401).send({ error: 'unauthorized' });
    req.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: 'internal' });
  });

  await ensureBootstrapAdmin();
  await ensureSeedDevDriver(); // dev/test only — pilot device pairing (Phase 1)
  return app;
}
