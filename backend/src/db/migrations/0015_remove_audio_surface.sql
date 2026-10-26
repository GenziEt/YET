-- Phase 2 (Option B): engine-audio classification removed from the roadmap
-- surface. No capture, no consent scope, no ingest kind, no storage — so the
-- database must not accept 'audio_engine' rows either. Additive + idempotent:
-- drop the old CHECK and recreate it over the frozen SensorEventSchema enum in
-- src/modules/ingest/service.ts.
--
-- Historical data stays valid:
--   * consent_records rows that granted the legacy 'audio' scope are untouched
--     (read paths still parse them; ALL_CONSENT_SCOPES keeps the name).
--   * consent_policies seed row 'consent-v1' is corrected below so exports and
--     compliance reports match the code registry (optional_scopes = '{}').
--   * No sensor_events with kind='audio_engine' were ever produced by a shipped
--     build (the collector never emitted the kind); the DELETE guard makes this
--     migration safe even on a dev DB where one was inserted manually.

ALTER TABLE sensor_events DROP CONSTRAINT IF EXISTS sensor_events_kind_check;
ALTER TABLE sensor_events ADD CONSTRAINT sensor_events_kind_check
  CHECK (kind IN ('accelerometer','gyroscope','harsh_brake',
                  'harsh_accel','turn','vibration_gate'));

DELETE FROM sensor_events WHERE kind = 'audio_engine';

UPDATE consent_policies
   SET optional_scopes = '{}'
 WHERE id = 'consent-v1' AND optional_scopes = ARRAY['audio'];
