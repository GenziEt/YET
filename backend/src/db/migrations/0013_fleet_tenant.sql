-- ============================================================================
-- 0013: Phase 0 — Fleet/tenant identity as a first-class entity (PDPP §1.7,
-- blueprint Module 1 "fleet manager accounts" + cross-fleet scoping).
--
-- Before this migration "a fleet" was a free-text `vehicles.fleet_name`, which
-- cannot scope authorization: two fleets could share a string by accident and
-- there was no tenant row to attach users or agreements to. This migration:
--   1. creates `fleets` (the tenant) with an audit-friendly status lifecycle;
--   2. attaches every user (DRIVER / FLEET_MANAGER) to a fleet via FK;
--      ADMIN remains global (fleet_id NULL) — platform operator;
--   3. attaches vehicles to fleets;
--   4. backfills one fleet per distinct historical fleet_name so existing data
--      stays reachable;
--   5. adds the consent-policy registry table (code registry mirrored in DB
--      for audit/reporting queries; code remains authoritative at runtime).
-- Idempotent: safe to re-run inside its own transaction (runner guarantees one
-- apply, but local dev databases were created before numbering existed).
-- ============================================================================

CREATE TABLE IF NOT EXISTS fleets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT UNIQUE NOT NULL,             -- display + matching key
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'SUSPENDED')),  -- suspended ⇒ ingest denied
  -- Processor-agreement reference (PDPP §1.7): where the signed contract with
  -- the fleet customer lives. Validated at boot when PROCESSORS_ACTIVE lists it.
  agreement_ref   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill: one fleet per distinct non-null historical fleet_name (plus a
-- default fleet for any vehicle that never had one). Deterministic ordering so
-- repeated runs on partially-migrated databases converge to the same rows.
INSERT INTO fleets (name)
SELECT DISTINCT trim(v.fleet_name) FROM vehicles v
 WHERE v.fleet_name IS NOT NULL AND trim(v.fleet_name) <> ''
ON CONFLICT (name) DO NOTHING;

INSERT INTO fleets (name) VALUES ('Unassigned Fleet') ON CONFLICT (name) DO NOTHING;

DO $$ BEGIN
  ALTER TABLE vehicles ADD COLUMN fleet_id UUID REFERENCES fleets(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

UPDATE vehicles
   SET fleet_id = f.id
  FROM fleets f
 WHERE vehicles.fleet_id IS NULL
   AND (trim(coalesce(vehicles.fleet_name, '')) = f.name
        OR (trim(coalesce(vehicles.fleet_name, '')) = '' AND f.name = 'Unassigned Fleet'));

DO $$ BEGIN
  ALTER TABLE vehicles ALTER COLUMN fleet_id SET NOT NULL;
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_vehicles_fleet ON vehicles(fleet_id);

-- Users belong to exactly one fleet when they are DRIVER or FLEET_MANAGER.
-- (Postgres has no conditional FK; enforcement lives in the trigger below plus
-- route-level guards, while the column itself stays nullable for ADMINs.)
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN fleet_id UUID REFERENCES fleets(id);
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

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

-- Seed fleets referenced by existing users' assignments: give every driver a
-- fleet derived from their active vehicle (falls back to Unassigned Fleet).
WITH target AS (
  SELECT va.driver_id, v.fleet_id
    FROM driver_vehicle_assignments va
    JOIN vehicles v ON v.id = va.vehicle_id
   WHERE va.unassigned_at IS NULL
)
UPDATE users u SET fleet_id = t.fleet_id FROM target t
 WHERE u.id = t.driver_id AND u.fleet_id IS NULL;
UPDATE users SET fleet_id = (SELECT id FROM fleets WHERE name = 'Unassigned Fleet')
 WHERE role IN ('DRIVER', 'FLEET_MANAGER') AND fleet_id IS NULL;

-- Consent policy registry — mirrors src/modules/identity/consent.ts so reports
-- and compliance exports can query versions without the app. Runtime authority
-- stays in code; this table is populated by the API layer on version publish.
CREATE TABLE IF NOT EXISTS consent_policies (
  id               TEXT PRIMARY KEY,                -- "consent-v1"
  released_at      DATE NOT NULL,
  required_scopes  TEXT[] NOT NULL,
  optional_scopes  TEXT[] NOT NULL DEFAULT '{}',
  is_current       BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_consent_policy
  ON consent_policies (is_current) WHERE is_current;

INSERT INTO consent_policies (id, released_at, required_scopes, optional_scopes, is_current)
VALUES ('consent-v1', DATE '2026-01-15', ARRAY['location','motion'], ARRAY['audio'], true)
ON CONFLICT (id) DO NOTHING;
