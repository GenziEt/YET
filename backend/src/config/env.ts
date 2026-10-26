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
  // §1.10.3 read/write separation: Reporting reads here when set. Must also be an
  // Ethiopian-resident replica (PDPP §1.7) — replicas inherit the sovereignty rule.
  READER_DATABASE_URL: z.string().startsWith('postgres').optional().or(z.literal('')).transform((v) => v || undefined),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET too short'),
  JWT_ACCESS_TTL: z.string().default('12h'),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(8).optional(),

  OSRM_BASE_URL: z.string().url().default('http://localhost:5000'),
  NOMINATIM_BASE_URL: z.string().url().default('http://localhost:8081'),
  OSM_USER_AGENT: z.string().default('YET-tracking/0.1 (ops-contact@yet.local)'),
  // Phase 3 routing resilience: bounded retry on NETWORK-ABORT failures only
  // (connection refused / DNS hiccup / timeout). HTTP responses — even 4xx/5xx
  // with a body — are never retried; they descend the degradation ladder at once.
  OSRM_RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(1),
  OSRM_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).default(120),

  INGEST_RATE_LIMIT_PER_MIN: z.coerce.number().int().default(60), // §1.10.4
  INGEST_MAX_BATCH_FIXES: z.coerce.number().int().default(100),   // Phase 1 batch contract
  INGEST_MAX_BATCH_SENSORS: z.coerce.number().int().default(2000),// Phase 2: 10 Hz sensor bursts (§1.8.5)

  // Module 3 — Trip Engine thresholds (Phase 2). Defaults verbatim from the blueprint.
  TRIP_STOPPED_AFTER_S: z.coerce.number().int().positive().default(60),          // §1.3 GPS-off gate
  TRIP_SEPARATION_THRESHOLD_M: z.coerce.number().positive().default(50),         // §1.4 default
  TRIP_RETURN_THRESHOLD_M: z.coerce.number().positive().default(30),             // §1.4 hysteresis
  TRIP_IDLE_TIMEOUT_S: z.coerce.number().int().positive().default(1800),         // auto-END gap
  TRIP_SEPARATION_NOTIFY_MIN: z.coerce.number().int().positive().default(45),    // §1.4 45-min timer

  // Module 3 — on-device sensor-fusion CLASSIFICATION thresholds (Phase 2, §1.3).
  // These are the calibrated values published to the driver app via
  // GET /trips/classification-config; the same numbers parameterize the device
  // classifiers (lib/features/trip/event_classifier.dart) and the server-side
  // fallback classifier over raw samples (classifyRawMotionEvents below).
  // Nothing in the pipeline hard-codes them — configuration, not magic numbers.
  HARSH_BRAKE_THRESHOLD_MPS2: z.coerce.number().positive().default(3.5),   // longitudinal peak (§1.3)
  HARSH_ACCEL_THRESHOLD_MPS2: z.coerce.number().positive().default(2.5),   // longitudinal peak (§1.3)
  TURN_RATE_THRESHOLD_DPS: z.coerce.number().positive().default(35),       // gyro |z| deg/s …
  TURN_MIN_DURATION_MS: z.coerce.number().int().positive().default(1000),  // … sustained > 1 s (§1.3)
  MOTION_VARIANCE_THRESHOLD: z.coerce.number().positive().default(0.05),   // vibration gate variance

  // Module 5 — Notification (Phase 5). FCM is the primary push channel; when real
  // credentials are absent (dev, pre-pilot) dispatch runs in DRY-RUN mode: the full
  // template/dedupe/log pipeline executes and messages are recorded as QUEUED for a
  // local dispatcher to pick up. Wire FCM_PROJECT + FCM_SERVICE_ACCOUNT_JSON (GCP
  // service account JSON, single-line base64 or raw) to go live. Real credentials
  // land with the Ethiopian hosting partner's project — see docs/COMPLIANCE-PDPP.md.
  FCM_PROJECT: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  SMS_GATEWAY_URL: z.string().url().optional(),          // local Ethiopian SMS gateway (§Phase 5)
  SMS_GATEWAY_SENDER: z.string().default('YET'),
  NOTIFY_SEPARATION_SWEEP_S: z.coerce.number().int().positive().default(60), // timer scan cadence
  ERASURE_WINDOW_DAYS: z.coerce.number().int().positive().default(30),   // §1.7 erasure horizon (Master spec)
  RETENTION_KEEP_EVERY_N: z.coerce.number().int().min(2).default(10),    // §1.10.6 downsampling "every 10th"
  RETENTION_AGE_DAYS: z.coerce.number().int().positive().default(90),    // §1.10.6 raw-fix age threshold

  // --- Phase 0 compliance-skeleton knobs ----------------------------------------
  // Read through process.env inside validateComplianceBoot() (live values at
  // boot, so a test can mutate the environment and re-validate without module
  // reload). Declared here so the contract is visible in one place and shows up
  // in .env.example documentation:
  //   ECA_REGISTRATION_STATUS      not_started|in_progress|submitted|completed
  //   ECA_REGISTRATION_NUMBER      authority-assigned reference once submitted
  //   PROCESSORS_ACTIVE            comma list of KNOWN_PROCESSORS identifiers
  //   DPA_<PROCESSOR>_REFERENCE    signed processor-agreement reference per active processor
  //   BREACH_NOTIFICATION_CONTACT  reachable email for the 72h ECA breach duty
  ECA_REGISTRATION_STATUS: z.string().optional(),
  ECA_REGISTRATION_NUMBER: z.string().optional(),
  PROCESSORS_ACTIVE: z.string().optional(),
  BREACH_NOTIFICATION_CONTACT: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

/* ---------------- Compliance skeleton: fail-closed boot validation ---------- */
/* These are code-level gates (Phase 0 deliverable), not documentation. The
 * process REFUSES TO START when a production compliance precondition is
 * unmet — see docs/COMPLIANCE-PDPP.md for the organizational counterpart. */

/** PDPP §1.7 data-residency allowlist: Ethiopian country codes. A DATABASE_URL
 *  host that is not one of these (or an explicitly registered residency host)
 *  means personal data collected in Ethiopia would leave the country, which
 *  Proclamation No. 1321/2024 forbids without a lawful cross-border basis. */
export const ETHIOPIA_RESIDENCY_COUNTRY_CODES = ['et'] as const;

/** Hostname suffixes known to terminate inside Ethiopia (hosting partner). */
const RESIDENCY_HOST_SUFFIXES = ['.ethiotelecom.net', '.ethernet-et.co.et'];

function hostnameOf(postgresUrl: string): string | null {
  try {
    return new URL(postgresUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when the DB host is acceptable for Ethiopian personal-data residency.
 *  Loopback/private space is treated as "dev" (no real personal data flows). */
export function isResidencyHostAllowed(host: string): boolean {
  if (/^(127\.|::1$|localhost$|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
  if (host.endsWith('.et')) return true;
  return RESIDENCY_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

export interface ComplianceBootReport {
  errors: string[];
  warnings: string[];
}

/**
 * validateComplianceBoot runs every production compliance gate at startup and
 * returns violations. buildApp() calls it and refuses to listen when `errors`
 * is non-empty (fail-closed). In development/test these are surfaced as
 * warnings so local work stays possible while the contract remains executable
 * and unit-testable.
 */
export function validateComplianceBoot(e = env, prod = isProd): ComplianceBootReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Secret hygiene: refuse weak/dev placeholders in production -------------
  if (prod) {
    if (e.JWT_SECRET.length < 32) errors.push('JWT_SECRET must be >= 32 bytes in production');
    if (/change-me|dev-only|yet-local/i.test(e.JWT_SECRET)) errors.push('JWT_SECRET still carries a template/dev placeholder value');
    if (!e.ADMIN_BOOTSTRAP_EMAIL || !e.ADMIN_BOOTSTRAP_PASSWORD) {
      errors.push('ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are required in production (administrator bootstrap hardening)');
    } else if (/change-me/i.test(e.ADMIN_BOOTSTRAP_PASSWORD)) {
      errors.push('ADMIN_BOOTSTRAP_PASSWORD still carries a template placeholder value');
    }
  }

  // --- Data residency (PDPP §1.7): primary + replica hosts --------------------
  const primaryHost = hostnameOf(e.DATABASE_URL);
  if (!primaryHost) errors.push('DATABASE_URL host could not be parsed for residency validation');
  else if (!isResidencyHostAllowed(primaryHost)) {
    const msg = `DATABASE_URL host "${primaryHost}" is outside the Ethiopian data-residency allowlist (PDPP §1.7)`;
    if (prod) errors.push(msg); else warnings.push(msg);
  }
  if (e.READER_DATABASE_URL) {
    const replicaHost = hostnameOf(e.READER_DATABASE_URL);
    if (replicaHost && !isResidencyHostAllowed(replicaHost)) {
      const msg = `READER_DATABASE_URL host "${replicaHost}" is outside the Ethiopian data-residency allowlist — replicas inherit sovereignty (PDPP §1.7)`;
      if (prod) errors.push(msg); else warnings.push(msg);
    }
  }

  // --- ECA registration status (§1.2 / Phase 0 compliance deliverable) --------
  // Code-level registry of the controller-registration lifecycle. Production
  // refuses to start until the registration has at least been SUBMITTED to the
  // Ethiopian Communications Authority; COMPLETED is expected before scale-up.
  const ecaStatus = (process.env.ECA_REGISTRATION_STATUS ?? 'not_started').trim().toLowerCase();
  const ecaNumber = process.env.ECA_REGISTRATION_NUMBER ?? '';
  if (!ECA_STATUSES.includes(ecaStatus as EcaRegistrationStatus)) {
    errors.push(`ECA_REGISTRATION_STATUS "${ecaStatus}" is not one of ${ECA_STATUSES.join('|')}`);
  } else if (prod) {
    if (ecaStatus === 'not_started' || ecaStatus === 'in_progress') {
      errors.push('Data-controller registration with the Ethiopian Communications Authority must be at least SUBMITTED before production boot (PDPP §1.2, 72h breach duty presupposes a registered controller)');
    }
    if ((ecaStatus === 'submitted' || ecaStatus === 'completed') && ecaNumber.length < 5) {
      errors.push('ECA_REGISTRATION_NUMBER must record the authority-assigned reference once submitted');
    }
  } else if (ecaStatus === 'not_started') {
    warnings.push('ECA data-controller registration not started — required before pilot (tracked in docs/COMPLIANCE-PDPP.md)');
  }

  // --- Processor agreements (PDPP §1.7) ----------------------------------------
  // Every third party processing personal data on YET's behalf needs a signed
  // DPA recorded here. Production refuses to boot while a live processor has no
  // agreement reference. Dev defaults to none-active so local stacks start.
  const activeProcessors = parseProcessorList(process.env.PROCESSORS_ACTIVE);
  for (const p of activeProcessors) {
    const agreementRef = process.env[`DPA_${p.toUpperCase()}_REFERENCE`] ?? '';
    if (agreementRef.length < 5) {
      const msg = `Processor "${p}" is ACTIVE but has no signed processor agreement reference (set DPA_${p.toUpperCase()}_REFERENCE, PDPP §1.7)`;
      if (prod) errors.push(msg); else warnings.push(msg);
    }
  }

  // --- Breach response readiness (§1.2: 72h ECA notification) ------------------
  // The runbook exists in docs/COMPLIANCE-PDPP.md; the CODE artifact is the
  // contact that must be reachable when a breach is declared. Production
  // requires it to be configured; audit_log targeting (lib/audit.ts) supplies
  // the affected-subject enumeration within the window.
  const breachContact = process.env.BREACH_NOTIFICATION_CONTACT ?? '';
  if (prod && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(breachContact)) {
    errors.push('BREACH_NOTIFICATION_CONTACT must be a valid email in production (72h ECA notification duty, PDPP §1.2)');
  } else if (!breachContact) {
    warnings.push('BREACH_NOTIFICATION_CONTACT unset — configure before pilot; see docs/COMPLIANCE-PDPP.md breach runbook');
  }

  return { errors, warnings };
}

export type EcaRegistrationStatus = 'not_started' | 'in_progress' | 'submitted' | 'completed';
export const ECA_STATUSES: readonly EcaRegistrationStatus[] = ['not_started', 'in_progress', 'submitted', 'completed'];

/** Known processors of personal data on YET's behalf (hosting partner, SMS
 *  gateway, push provider). PROCESSORS_ACTIVE is a comma-separated list of
 *  these identifiers; each active one must carry DPA_<NAME>_REFERENCE. */
export const KNOWN_PROCESSORS = ['HOSTING_PARTNER', 'SMS_GATEWAY', 'FCM_PUSH'] as const;
export type KnownProcessor = (typeof KNOWN_PROCESSORS)[number];

export function parseProcessorList(raw: string | undefined): KnownProcessor[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is KnownProcessor => (KNOWN_PROCESSORS as readonly string[]).includes(s));
}
