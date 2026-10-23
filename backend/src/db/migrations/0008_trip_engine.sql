-- ============================================================================
-- 0008: Module 3 — Trip Engine (Phase 2)
-- Owns: trips, trip_events, driver_separation_log (§1.5).
-- All state transitions are EVENT-TIME based (§1.8.3): trip/event timestamps come
-- from device clocks, never received_at. Late/out-of-order batches re-evaluate the
-- affected window and upsert idempotently — no arrival-time assumptions anywhere.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE trip_state AS ENUM ('IDLE','STARTED','MOVING','STOPPED','ENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE separation_status AS ENUM ('SEPARATED','RETURNED','NOTIFIED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS trips (
  trip_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      UUID NOT NULL REFERENCES users(id),
  vehicle_id     UUID NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL,              -- event time of first fix (§1.8.3)
  ended_at       TIMESTAMPTZ,                      -- NULL = active trip
  last_activity_at TIMESTAMPTZ NOT NULL,            -- event time of latest processed fix
  state          trip_state NOT NULL DEFAULT 'STARTED',
  stop_lat       DOUBLE PRECISION,                  -- last known TRUCK position while STOPPED
  stop_lng       DOUBLE PRECISION,
  stop_at        TIMESTAMPTZ,                       -- when the truck stopped (event time)
  distance_m         BIGINT  NOT NULL DEFAULT 0,    -- filtered haversine summary (§ Phase 2)
  moving_duration_s  BIGINT  NOT NULL DEFAULT 0,
  stopped_duration_s BIGINT  NOT NULL DEFAULT 0,
  turn_count         INT     NOT NULL DEFAULT 0,
  harsh_event_count  INT     NOT NULL DEFAULT 0,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g. phone-vehicle alignment per trip
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_time CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- Natural key for the idempotent recompute upsert (§1.8.3): a reconstruction of
  -- the same event-time window always lands on the same row.
  CONSTRAINT uq_trips_identity UNIQUE (driver_id, vehicle_id, started_at)
);
-- One OPEN trip per vehicle at a time (a new trip may only start once the old closed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_trips_open_vehicle
  ON trips (vehicle_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trips_driver_time ON trips (driver_id, started_at);
CREATE INDEX IF NOT EXISTS idx_trips_vehicle_time ON trips (vehicle_id, started_at);

-- Trip events: THE idempotency key is (trip_id, event_type, event_timestamp) —
-- verbatim from the Offline Contract §1.8.3. Re-processing any window upserts.
CREATE TABLE IF NOT EXISTS trip_events (
  event_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id        UUID NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  vehicle_id     UUID NOT NULL,
  driver_id      UUID NOT NULL,
  event_type     TEXT NOT NULL CHECK (event_type IN
                   ('TRIP_STARTED','MOVING','STOPPED','TURN','HARSH_BRAKE','HARSH_ACCEL',
                    'DRIVER_SEPARATED','DRIVER_RETURNED','GPS_DUTY_RESUME','TRIP_ENDED')),
  event_timestamp TIMESTAMPTZ NOT NULL,             -- EVENT time (§1.8.3)
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb, -- both locations on separation etc.
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_event
  ON trip_events (trip_id, event_type, event_timestamp);
CREATE INDEX IF NOT EXISTS idx_trip_events_trip ON trip_events (trip_id, event_timestamp);

-- Driver-left-vehicle log (§1.4): truck stop location AND driver location, timer to
-- fleet-manager notification (Notification module consumes in Phase 5).
CREATE TABLE IF NOT EXISTS driver_separation_log (
  separation_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         UUID NOT NULL REFERENCES trips(trip_id) ON DELETE CASCADE,
  vehicle_id      UUID NOT NULL,
  driver_id       UUID NOT NULL,
  status          separation_status NOT NULL DEFAULT 'SEPARATED',
  separated_at    TIMESTAMPTZ NOT NULL,              -- event time of first diverging fix
  returned_at     TIMESTAMPTZ,
  truck_stop_lat  DOUBLE PRECISION NOT NULL,         -- last known truck position
  truck_stop_lng  DOUBLE PRECISION NOT NULL,
  driver_lat      DOUBLE PRECISION NOT NULL,         -- driver's current position
  driver_lng      DOUBLE PRECISION NOT NULL,
  distance_m      REAL NOT NULL,                     -- separation distance at flag time
  notified_fleet_manager BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotent upsert key for late/out-of-order replay (§1.8.3).
  CONSTRAINT uq_separation_trip_time UNIQUE (trip_id, separated_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_separation_open_trip
  ON driver_separation_log (trip_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_separation_vehicle ON driver_separation_log (vehicle_id, separated_at);
