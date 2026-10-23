-- ============================================================================
-- 0009: Module 4 — Geofence & Route (Phase 3)
-- Owns: geofences, route_cache (§1.5). PostGIS extension installed in 0001
-- specifically for this migration ("used in Phase 3 geofences").
--
-- Design notes:
--  * A geofence is EITHER a circle (center + radius_m) or a polygon (ring).
--    Stored as a single PostGIS `geom` column so boundary tests are one index
--    lookup regardless of shape; radius_m kept separately because ST_DWithin
--    on geography uses it directly and is far cheaper than polygonizing circles.
--  * Crossing detection is server-side per fix (§Phase 3 deliverable): the
--    previous fix's inside/outside status vs the new fix's status emits
--    GEOFENCE_ENTER / GEOFENCE_EXIT. Idempotent by construction: events live in
--    trip_events with the SAME upsert key (trip_id, event_type, event_timestamp)
--    mandated by §1.8.3, so an offline-replayed batch re-emits identical events.
--  * route_cache mirrors the Redis cache (Redis is primary at runtime; this table
--    survives Redis eviction/restart and doubles as the audit trail of routing
--    calls). Key = normalized "from,to" pair exactly as GET /route accepts it.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE geofence_kind AS ENUM ('CIRCLE','POLYGON');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE geofence_category AS ENUM ('WAREHOUSE','CUSTOMER_SITE','RESTRICTED_ZONE','DEPOT','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS geofences (
  geofence_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  kind          geofence_kind NOT NULL,
  category      geofence_category NOT NULL DEFAULT 'OTHER',
  -- CIRCLE: geom = center point, radius_m required.
  -- POLYGON: geom = MULTIPOLYGON built from a closed exterior ring, radius_m NULL.
  geom          geometry NOT NULL,                -- SRID 4326 enforced below
  radius_m      DOUBLE PRECISION CHECK (radius_m IS NULL OR radius_m > 0),
  center_lat    DOUBLE PRECISION CHECK (center_lat BETWEEN -90 AND 90),
  center_lng    DOUBLE PRECISION CHECK (center_lng BETWEEN -180 AND 180),
  ring_json     JSONB,                            -- [[lat,lng],...] for dashboard redraw
  active        BOOLEAN NOT NULL DEFAULT TRUE,    -- inactive fences stop generating events
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_srid CHECK (ST_SRID(geom) = 4326),
  CONSTRAINT chk_circle_shape CHECK (
    (kind = 'CIRCLE'  AND ST_GeometryType(geom) = 'ST_Point'   AND radius_m IS NOT NULL)
    OR
    (kind = 'POLYGON' AND ST_GeometryType(geom) = 'ST_MultiPolygon' AND radius_m IS NULL)
  )
);

-- GiST spatial index powering the per-fix candidate lookup (ST_DWithin on the
-- geometry plane with a generous cap keeps the search bounded to nearby fences).
CREATE INDEX IF NOT EXISTS idx_geofences_geom ON geofences USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_geofences_active ON geofences (active);

-- Trip Engine's event-type CHECK list must learn about geofence crossings so the
-- crossing evaluator can persist GEOFENCE_ENTER/EXIT through the same idempotent
-- trip_events table (single source of truth for trip timelines; no parallel table).
ALTER TABLE trip_events DROP CONSTRAINT IF EXISTS trip_events_event_type_check;
ALTER TABLE trip_events ADD CONSTRAINT trip_events_event_type_check CHECK (event_type IN
  ('TRIP_STARTED','MOVING','STOPPED','TURN','HARSH_BRAKE','HARSH_ACCEL',
   'DRIVER_SEPARATED','DRIVER_RETURNED','GPS_DUTY_RESUME','TRIP_ENDED',
   'GEOFENCE_ENTER','GEOFENCE_EXIT'));

-- Server-side route cache companion to Redis (§1.10.2). Written on every OSRM
-- miss; read never falls back here automatically (Redis first) but provides
-- warm-start after cache flushes and satisfies "Owns: route_cache" (§1.5).
CREATE TABLE IF NOT EXISTS route_cache (
  cache_key     TEXT PRIMARY KEY,                 -- "fromLat,fromLng|toLat,toLng|profile"
  from_lat      DOUBLE PRECISION NOT NULL,
  from_lng      DOUBLE PRECISION NOT NULL,
  to_lat        DOUBLE PRECISION NOT NULL,
  to_lng        DOUBLE PRECISION NOT NULL,
  profile       TEXT NOT NULL DEFAULT 'driving',
  distance_m    BIGINT NOT NULL,
  duration_s    BIGINT NOT NULL,                  -- OSRM travel time (seconds)
  geometry_json JSONB NOT NULL,                   -- encoded-polyline decoded [lat,lng][]
  osrm_source   TEXT NOT NULL DEFAULT 'osrm',     -- osrm | fallback_straight
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL              -- mirrors Redis TTL for warm-start
);
CREATE INDEX IF NOT EXISTS idx_route_cache_expiry ON route_cache (expires_at);
