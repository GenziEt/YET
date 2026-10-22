-- ============================================================================
-- 0002: Module 1 — Identity & Access
-- Owns: users, vehicles, driver_vehicle_assignments, refresh_tokens, audit_log
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role          user_role   NOT NULL,
  full_name     TEXT        NOT NULL,
  phone_e164    TEXT        UNIQUE,               -- primary identifier for drivers
  email         TEXT        UNIQUE,
  password_hash TEXT        NOT NULL,             -- argon2id/bcrypt encoded string
  locale        TEXT        NOT NULL DEFAULT 'en' CHECK (locale IN ('en','am')),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number   TEXT UNIQUE NOT NULL,            -- Ethiopian plates: AA-12345
  fleet_name     TEXT,
  vehicle_type   vehicle_type NOT NULL DEFAULT 'TRUCK',
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A driver is assigned to at most one active vehicle at a time
-- (exclusion constraint requires btree_gist; enabled in this migration).
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$ BEGIN
  ALTER TABLE driver_vehicle_assignments DROP CONSTRAINT IF EXISTS dva_no_overlap;
  CREATE TABLE IF NOT EXISTS driver_vehicle_assignments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id     UUID NOT NULL REFERENCES users(id),
    vehicle_id    UUID NOT NULL REFERENCES vehicles(id),
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    unassigned_at TIMESTAMPTZ
  );
  ALTER TABLE driver_vehicle_assignments ADD CONSTRAINT dva_no_overlap
    EXCLUDE USING gist (driver_id WITH =, tstzrange(assigned_at, unassigned_at, '[)') WITH &&);
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT UNIQUE NOT NULL,               -- sha256 of presented token
  device_id   TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- PDPP §1.7 breach-readiness: log all access to personal data; sufficient to identify
-- affected driver IDs within the 72h ECA notification window.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     UUID,                               -- NULL = system
  action       TEXT NOT NULL,                      -- login, read_locations, delete_history...
  target_user  UUID,                               -- whose personal data was touched
  ip           INET,
  detail       JSONB,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_target_time ON audit_log(target_user, occurred_at);
