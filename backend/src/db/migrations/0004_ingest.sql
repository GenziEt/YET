-- ============================================================================
-- 0004: Module 2 — Ingest (schema prepared in Phase 0; endpoints land Phase 1)
-- location_fixes partitioned by month (§1.10.1). Data retention: raw fixes older
-- than 90 days are downsampled by a scheduled job (§1.10.6) — implemented P5.
-- ============================================================================

-- Server idempotency (§1.8.2): batch_id UUID v4 unique index. Duplicate batch =>
-- ingest service returns 200 already_received:true. THE only safe offline replay.
CREATE TABLE IF NOT EXISTS ingest_batches (
  batch_id      UUID PRIMARY KEY,                 -- client-generated, unique index = contract
  driver_id     UUID NOT NULL REFERENCES users(id),
  vehicle_id    UUID REFERENCES vehicles(id),
  fix_count     INT  NOT NULL,
  sensor_count  INT  NOT NULL DEFAULT 0,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_sent_at TIMESTAMPTZ                      -- for upload-latency pilot metric (P4)
);

-- Declarative monthly partitioning keeps indices small and makes expiration a fast
-- partition drop instead of row-by-row delete (§1.10.1). PK must contain partition key.
CREATE TABLE IF NOT EXISTS location_fixes (
  fix_id        BIGINT GENERATED ALWAYS AS IDENTITY,
  batch_id      UUID NOT NULL,
  vehicle_id    UUID NOT NULL,
  driver_id     UUID NOT NULL,
  fix_timestamp TIMESTAMPTZ NOT NULL,             -- EVENT time (client GPS clock), §1.8.3
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  lat           DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng           DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  speed_mps     REAL,                             -- m/s from device
  accuracy_m    REAL,
  heading_deg   REAL CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
  altitude_m    REAL,
  provider      TEXT,                             -- gps | fused | network-tower fallback (§1.3)
  geom          geometry(Point, 4326),
  PRIMARY KEY (fix_id, fix_timestamp)
) PARTITION BY RANGE (fix_timestamp);

-- Indices exactly as guardrails dictate: (vehicle_id, fix_timestamp) and
-- (driver_id, fix_timestamp). NO index on raw lat/lng (§1.10.1).
CREATE INDEX IF NOT EXISTS idx_fixes_vehicle_time ON location_fixes (vehicle_id, fix_timestamp);
CREATE INDEX IF NOT EXISTS idx_fixes_driver_time  ON location_fixes (driver_id, fix_timestamp);
CREATE INDEX IF NOT EXISTS idx_fixes_batch        ON location_fixes (batch_id);

-- Auto-create monthly partitions (pg_partman not required at launch scale).
CREATE OR REPLACE FUNCTION ensure_month_partition(parent_table TEXT, ts TIMESTAMPTZ) RETURNS void AS $$
DECLARE
  part_name TEXT := parent_table || '_' || to_char(date_trunc('month', ts), 'YYYY_MM');
  start_ts  TIMESTAMPTZ := date_trunc('month', ts);
  end_ts    TIMESTAMPTZ := date_trunc('month', ts) + INTERVAL '1 month';
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    part_name, parent_table, start_ts, end_ts);
END $$ LANGUAGE plpgsql;

-- Pre-create current + next 2 months so first writes never fail.
SELECT ensure_month_partition('location_fixes', now());
SELECT ensure_month_partition('location_fixes', now() + INTERVAL '1 month');
SELECT ensure_month_partition('location_fixes', now() + INTERVAL '2 months');

-- Sensor events share the same durability contract as GPS fixes (§1.8.5).
CREATE TABLE IF NOT EXISTS sensor_events (
  event_id      BIGINT GENERATED ALWAYS AS IDENTITY,
  batch_id      UUID NOT NULL,
  vehicle_id    UUID NOT NULL,
  driver_id     UUID NOT NULL,
  event_timestamp TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind          TEXT NOT NULL CHECK (kind IN ('accelerometer','gyroscope','harsh_brake',
                                               'harsh_accel','turn','vibration_gate','audio_engine')),
  payload       JSONB NOT NULL,                   -- samples/thresholds; downsampled if storage-critical (§1.8.6)
  PRIMARY KEY (event_id, event_timestamp)
) PARTITION BY RANGE (event_timestamp);
CREATE INDEX IF NOT EXISTS idx_sensors_vehicle_time ON sensor_events (vehicle_id, event_timestamp);
CREATE INDEX IF NOT EXISTS idx_sensors_driver_time  ON sensor_events (driver_id, event_timestamp);

SELECT ensure_month_partition('sensor_events', now());
SELECT ensure_month_partition('sensor_events', now() + INTERVAL '1 month');
SELECT ensure_month_partition('sensor_events', now() + INTERVAL '2 months');

-- Idempotent replay safety at row level even if a batch row insert partially failed:
-- (batch_id, vehicle_id, fix_timestamp) uniqueness makes INSERT ... ON CONFLICT DO
-- NOTHING (§1.10.1) a true no-op on replay.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fixes_batch_time ON location_fixes (batch_id, fix_timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sensors_batch_time ON sensor_events (batch_id, event_timestamp, kind);
