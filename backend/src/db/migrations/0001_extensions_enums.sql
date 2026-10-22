-- ============================================================================
-- 0001: Extensions & enums
-- PostGIS installed now (used in Phase 3 geofences) so later migrations stay simple.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;          -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS postgis;           -- geometry for geofences/fixes (P3+)

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('DRIVER', 'FLEET_MANAGER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sync_state AS ENUM ('PENDING', 'UPLOADING', 'ACKED', 'PRUNED');
  -- Client-side enum mirrored server-side for audit of offline contract (§1.8.1).
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE vehicle_type AS ENUM ('TRUCK', 'MINI_BUS', 'VAN', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
