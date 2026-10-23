import 'dotenv/config';
import { z } from 'zod';
/**
 * Centralized, validated environment configuration.
 * Fail fast at boot on misconfiguration — a silently wrong DATABASE_URL is a
 * data-residency (PDPP §1.7) risk, so we validate shape explicitly.
 */
const EnvSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().startsWith('postgres', 'DATABASE_URL must be a Postgres URL stored in Ethiopia (§1.7)'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    JWT_SECRET: z.string().min(16, 'JWT_SECRET too short'),
    JWT_ACCESS_TTL: z.string().default('12h'),
    ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
    ADMIN_BOOTSTRAP_PASSWORD: z.string().min(8).optional(),
    OSRM_BASE_URL: z.string().url().default('http://localhost:5000'),
    NOMINATIM_BASE_URL: z.string().url().default('http://localhost:8081'),
    OSM_USER_AGENT: z.string().default('YET-tracking/0.1 (ops-contact@yet.local)'),
    INGEST_RATE_LIMIT_PER_MIN: z.coerce.number().int().default(60), // §1.10.4
    INGEST_MAX_BATCH_FIXES: z.coerce.number().int().default(100), // Phase 1 batch contract
    INGEST_MAX_BATCH_SENSORS: z.coerce.number().int().default(2000), // Phase 2: 10 Hz sensor bursts (§1.8.5)
    // Module 3 — Trip Engine thresholds (Phase 2). Defaults verbatim from the blueprint.
    TRIP_STOPPED_AFTER_S: z.coerce.number().int().positive().default(60), // §1.3 GPS-off gate
    TRIP_SEPARATION_THRESHOLD_M: z.coerce.number().positive().default(50), // §1.4 default
    TRIP_RETURN_THRESHOLD_M: z.coerce.number().positive().default(30), // §1.4 hysteresis
    TRIP_IDLE_TIMEOUT_S: z.coerce.number().int().positive().default(1800), // auto-END gap
    TRIP_SEPARATION_NOTIFY_MIN: z.coerce.number().int().positive().default(45), // §1.4 45-min timer
});
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
}
export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
//# sourceMappingURL=env.js.map