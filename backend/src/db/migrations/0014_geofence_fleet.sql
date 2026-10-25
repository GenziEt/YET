-- ============================================================================
-- 0014: Phase 0 — Geofence tenancy. Zones become fleet-owned entities so every
-- geofence read/write can be tenant-scoped at the route boundary (Master spec:
-- "Fleet scoping is enforced on every geofence, route, and ETA read and write").
--
-- Idempotent + ordered after 0013 (fleets/users.fleet_id exist by then).
-- Backfill rule: a zone belongs to its creator's fleet; zones created by a
-- platform ADMIN (no fleet) fall into the reserved 'Unassigned Fleet' tenant,
-- which the service layer treats as admin-only-visible.
-- ============================================================================

DO $$ BEGIN
  ALTER TABLE geofences ADD COLUMN fleet_id UUID REFERENCES fleets(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reserved tenant for legacy/admin-created zones (deterministic name, id derived
-- from it so re-running the backfill converges to the same value).
INSERT INTO fleets (name, status)
VALUES ('Unassigned Fleet', 'ACTIVE')
ON CONFLICT (name) DO NOTHING;

UPDATE geofences g
   SET fleet_id = COALESCE(
        (SELECT u.fleet_id FROM users u WHERE u.id = g.created_by),
        (SELECT f.id FROM fleets f WHERE f.name = 'Unassigned Fleet'))
 WHERE g.fleet_id IS NULL;

DO $$ BEGIN
  ALTER TABLE geofences ALTER COLUMN fleet_id SET NOT NULL;
EXCEPTION WHEN dependent_objects_still_exist OR invalid_table_definition THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_geofences_fleet ON geofences(fleet_id);
