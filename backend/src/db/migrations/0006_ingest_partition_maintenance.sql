-- ============================================================================
-- 0006: Phase 1 — Ingest partition maintenance (§1.10.1)
-- Late/offline replay can land fixes in months that were never pre-created
-- (driver in airplane mode for weeks). ensure_month_partition() exists since
-- 0004; here we add a scheduled-style sweep the ingest service calls cheaply
-- before every batch write, plus a rolling pre-creation helper for cron.
-- ============================================================================

-- Create partitions covering [now - 12 months .. now + 3 months] for both
-- time-partitioned tables. Idempotent (CREATE TABLE IF NOT EXISTS inside).
CREATE OR REPLACE FUNCTION ensure_partition_range(parent_table TEXT,
                                                  from_ts TIMESTAMPTZ,
                                                  to_ts TIMESTAMPTZ) RETURNS void AS $$
DECLARE m TIMESTAMPTZ;
BEGIN
  FOR m IN SELECT generate_series(date_trunc('month', from_ts),
                                  date_trunc('month', to_ts),
                                  INTERVAL '1 month') LOOP
    PERFORM ensure_month_partition(parent_table, m);
  END LOOP;
END $$ LANGUAGE plpgsql;

SELECT ensure_partition_range('location_fixes',  now() - INTERVAL '12 months', now() + INTERVAL '3 months');
SELECT ensure_partition_range('sensor_events',   now() - INTERVAL '12 months', now() + INTERVAL '3 months');
