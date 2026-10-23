-- ============================================================================
-- 0010: Phase 4 — Driver App Hardening & Field Pilot telemetry
-- Owned by Module 2 (Ingest) tables + Module 6-style read-only pilot rollups.
--
-- Two artifacts:
--  * driver_diagnostics — one row per in-app feedback tap (§Phase 4 deliverable):
--    battery level, GPS accuracy, last fix age, network type, pending sync count.
--    Carries batch_id for the SAME idempotency guarantee as location batches
--    (§1.8.2): a driver tapping "report problem" while repeatedly offline must
--    never multiply incidents on the pilot dashboard.
--  * trip_battery_samples — battery % at trip start/end reported by the app via
--    POST /ingest/battery. Drain estimate = start − end over trip duration,
--    scaled to an 8-hour shift for the Phase 4 gate (median ≤ 25%/8h; if the
--    median exceeds it we return to Phase 2 and re-tune sensor gating).
-- ============================================================================

CREATE TABLE IF NOT EXISTS driver_diagnostics (
  diag_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       UUID NOT NULL UNIQUE,               -- §1.8.2 client idempotency key
  driver_id      UUID NOT NULL REFERENCES users(id),
  vehicle_id     UUID REFERENCES vehicles(id),
  reported_at    TIMESTAMPTZ NOT NULL,               -- EVENT time from device clock (§1.8.3)
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  issue          TEXT NOT NULL CHECK (issue IN ('gps_not_working','battery_drain','sync_stuck','other')),
  battery_pct    REAL CHECK (battery_pct BETWEEN 0 AND 100),
  charging       BOOLEAN,
  last_fix_age_s INT,                                -- seconds since newest locally-cached fix
  last_accuracy_m REAL,                               -- accuracy of that fix
  network_type   TEXT,                                -- wifi | cellular | none | unknown
  pending_sync_count INT NOT NULL DEFAULT 0,          -- Offline Contract backlog at tap time
  trip_active    BOOLEAN NOT NULL DEFAULT false,
  app_version    TEXT,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- free-form extras (device model etc.)
  triaged        BOOLEAN NOT NULL DEFAULT false       -- ops runbook workflow flag
);
CREATE INDEX IF NOT EXISTS idx_diag_driver_time ON driver_diagnostics (driver_id, reported_at);
CREATE INDEX IF NOT EXISTS idx_diag_open ON driver_diagnostics (triaged, reported_at) WHERE NOT triaged;

CREATE TABLE IF NOT EXISTS trip_battery_samples (
  sample_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id       UUID NOT NULL,                      -- ingest batch that carried this sample
  driver_id      UUID NOT NULL REFERENCES users(id),
  vehicle_id     UUID NOT NULL,
  trip_started_at TIMESTAMPTZ NOT NULL,              -- event time of TRIP_STARTED fix (§1.8.3)
  taken_at       TIMESTAMPTZ NOT NULL,               -- event time of the battery reading
  phase          TEXT NOT NULL CHECK (phase IN ('trip_start','trip_end','mid_trip')),
  battery_pct    REAL NOT NULL CHECK (battery_pct BETWEEN 0 AND 100),
  charging       BOOLEAN NOT NULL DEFAULT false,     -- charger samples excluded from drain math
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotent replay: same (vehicle, started_at, phase) upserts to ONE sample.
  CONSTRAINT uq_battery_sample UNIQUE (vehicle_id, trip_started_at, phase)
);
CREATE INDEX IF NOT EXISTS idx_battery_vehicle_time ON trip_battery_samples (vehicle_id, taken_at);
