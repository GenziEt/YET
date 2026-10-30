-- ============================================================================
-- 0016: Driver Registration WITHOUT traditional login (identity-first model)
--
-- Design contract (see docs/DRIVER-ONBOARDING.md):
--   * A DRIVER is a PERSON. Identity = verified phone number + documents.
--     There is NO password for drivers: authentication is OTP at registration
--     plus persistent DEVICE PAIRING (device_identities). users.password_hash
--     becomes nullable — only staff roles (ADMIN / FLEET_MANAGER) keep it.
--   * Trucks/trailers are ASSETS, never account identity. They live in their
--     own tables and attach to drivers through TIME-BOUND assignments, so a
--     driver who changes truck keeps ONE account (update profile → new
--     assignment; admin reassignment closes the old one).
--   * Documents (license mandatory, others conditional) are rows with expiry
--     tracking and an admin verification lifecycle
--     (PENDING_REVIEW → VERIFIED / REJECTED).
--   * SMS OTP requests are recorded for abuse control; codes themselves are
--     Redis-only (short TTL), never persisted here.
-- Idempotent per the migration-runner contract (single transaction per file).
-- ============================================================================

-- users.password_hash: NULLABLE from here on. Drivers never set a password;
-- the trigger below enforces "password required for ADMIN/FLEET_MANAGER".
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

DO $$ BEGIN
  CREATE TYPE document_type AS ENUM
    ('DRIVING_LICENSE', 'NATIONAL_ID', 'INSURANCE', 'OWNERSHIP', 'ASSOCIATION_CARD', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_status AS ENUM ('PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ownership_status AS ENUM ('OWNER', 'EMPLOYEE_DRIVER', 'LEASED', 'ASSOCIATION', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Driver profile: license + professional attributes of the PERSON.
-- One row per driver-user; created by POST /auth/register.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_profiles (
  driver_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  license_number    TEXT NOT NULL,
  license_class     TEXT,                          -- category on the Ethiopian license
  license_expiry    DATE,                          -- tracked; drives EXPIRED doc status
  association_name  TEXT,                          -- optional truck/transport association
  ownership_status  ownership_status,              -- does the driver own the equipment?
  home_base         TEXT,                          -- free text (e.g. "Adama")
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_driver_profiles_license ON driver_profiles(license_number);

-- ---------------------------------------------------------------------------
-- Vehicles (trucks) & trailers as first-class ASSET entities.
-- vehicles already exists (plate_number, fleet_id, fleet_name, vehicle_type);
-- this migration enriches it rather than replacing it, so ingest/trip-engine
-- keys (vehicle_id) stay stable.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  ALTER TABLE vehicles ADD COLUMN make_model     TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE vehicles ADD COLUMN capacity_tons  NUMERIC(8,2);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE vehicles ADD COLUMN body_type      TEXT;   -- high bed / low bed / box …
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE vehicles ADD COLUMN ownership_status ownership_status;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE vehicles ADD COLUMN created_by_driver_id UUID REFERENCES users(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS trailers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number      TEXT UNIQUE NOT NULL,          -- trailer registration number
  trailer_type      TEXT,                          -- low bed, high bed, container…
  capacity_tons     NUMERIC(8,2),
  equipment_details TEXT,
  fleet_id          UUID REFERENCES fleets(id),    -- owning tenant when company-held
  created_by_driver_id UUID REFERENCES users(id),  -- self-registered asset (unassigned fleet)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trailers_fleet ON trailers(fleet_id);

DO $$ BEGIN
  ALTER TABLE driver_vehicle_assignments
    ADD COLUMN created_by_admin BOOLEAN NOT NULL DEFAULT true;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Time-bound driver↔trailer relationship (mirrors driver_vehicle_assignments).
CREATE TABLE IF NOT EXISTS driver_trailer_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id     UUID NOT NULL REFERENCES users(id),
  trailer_id    UUID NOT NULL REFERENCES trailers(id),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  unassigned_at TIMESTAMPTZ,
  created_by_admin BOOLEAN NOT NULL DEFAULT true
);
DO $$ BEGIN
  ALTER TABLE driver_trailer_assignments
    ADD CONSTRAINT dta_no_overlap
    EXCLUDE USING gist (driver_id WITH =, tstzrange(assigned_at, unassigned_at, '[)') WITH &&);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Driver documents: uploads with expiry + verification lifecycle.
-- Storage path lives on the Ethiopian-resident volume (PDPP §1.7); only the
-- reference is kept here — no binary data in Postgres.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type     document_type NOT NULL,
  file_path    TEXT NOT NULL,                      -- server-side storage key
  mime_type    TEXT,
  size_bytes   BIGINT,
  expires_on   DATE,                               -- e.g. license/insurance expiry
  status       document_status NOT NULL DEFAULT 'PENDING_REVIEW',
  review_note  TEXT,
  reviewed_by  UUID REFERENCES users(id),
  reviewed_at  TIMESTAMPTZ,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_driver ON driver_documents(driver_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_review ON driver_documents(status) WHERE status = 'PENDING_REVIEW';
-- One active document per (driver, type): re-upload replaces the previous row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_active
  ON driver_documents(driver_id, doc_type) WHERE status IN ('PENDING_REVIEW','VERIFIED');

-- ---------------------------------------------------------------------------
-- Device pairing (the "login" replacement). One row per paired install;
-- users.device_id (migration 0007) stays as the fast current-device pointer,
-- this table is the authoritative pairing registry with rotation support.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_identities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id        TEXT NOT NULL,                  -- stable per-install UUID from the app
  platform         TEXT,                           -- 'android' etc.
  app_version      TEXT,
  paired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at       TIMESTAMPTZ,
  revoke_reason    TEXT,
  UNIQUE (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_device_current ON device_identities(user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Phone-verification OTP audit trail. The CODE itself lives only in Redis
-- (key otp:{phone}, short TTL); this table records that a code was requested
-- for a phone at a time (abuse visibility + PDPP audit of personal-data use).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164  TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('REGISTER')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip          INET
);
CREATE INDEX IF NOT EXISTS idx_otp_phone_time ON otp_requests(phone_e164, requested_at);

-- ---------------------------------------------------------------------------
-- Guard: tenant roles must always carry a fleet (extend 0013's trigger).
-- Self-registered drivers sit in 'Unassigned Fleet' until an admin moves them;
-- they are never fleet-less, so every scoped read stays fail-closed correct.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_user_fleet_membership() RETURNS trigger AS $fn$
BEGIN
  IF NEW.role IN ('DRIVER', 'FLEET_MANAGER') AND NEW.fleet_id IS NULL THEN
    RAISE EXCEPTION 'users with role % must belong to a fleet (tenant scoping, PDPP §1.7)', NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.role = 'ADMIN' AND NEW.fleet_id IS NOT NULL THEN
    RAISE EXCEPTION 'ADMIN users are platform-global and must not carry fleet_id'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_fleet_membership ON users;
CREATE TRIGGER user_fleet_membership
  BEFORE INSERT OR UPDATE OF role, fleet_id ON users
  FOR EACH ROW EXECUTE FUNCTION trg_user_fleet_membership();

INSERT INTO fleets (name) VALUES ('Unassigned Fleet') ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Staff-password guard: ADMIN/FLEET_MANAGER authenticate with passwords
-- (back-office risk profile); DRIVERS authenticate with OTP + device pairing
-- and must NOT have a hash stored (defense against credential-stuffing on a
-- population that never chose a secret).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_user_password_policy() RETURNS trigger AS $fn$
BEGIN
  IF NEW.role IN ('ADMIN', 'FLEET_MANAGER') AND NEW.password_hash IS NULL THEN
    RAISE EXCEPTION 'role % requires a password_hash (staff login surface)', NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.role = 'DRIVER' AND NEW.password_hash IS NOT NULL THEN
    RAISE EXCEPTION 'drivers authenticate via OTP + device pairing; password_hash must be NULL'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_password_policy ON users;
CREATE TRIGGER user_password_policy
  BEFORE INSERT OR UPDATE OF role, password_hash ON users
  FOR EACH ROW EXECUTE FUNCTION trg_user_password_policy();
