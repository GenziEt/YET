-- ============================================================================
-- 0011: Module 5 — Notification (Phase 5) + Reporting/erasure support indexes
-- Owns: notification_templates, notification_log (§1.5). Trip Engine's
-- driver_separation_log.notified_fleet_manager column (created in 0008) becomes
-- meaningful here: it is the durable "already notified" marker that makes the
-- §1.4 45-minute separation timer fire EXACTLY ONCE across restarts and late
-- offline replays (§1.8.3 convergence).
--
-- Design notes:
--  * notification_log stores ONLY redacted delivery metadata (channel, provider
--    message id, status, error class) — never location coordinates or other
--    personal-data payloads. PDPP data minimization (§1.7) applies to our own
--    compliance tables too.
--  * Idempotency key uq_notif_dedupe (event_type, dedupe_key): the notification
--    evaluator recomputes windows repeatedly (every batch, out-of-order replay);
--    without this constraint every replay would re-push the same alert. A second
--    INSERT for the same logical event is a no-op (ON CONFLICT DO NOTHING).
--  * idx_*_time below back the Phase 5 Reporting reads and the DELETE-erasure
--    sweep so both stay inside the §1.9.4 budgets at pilot scale.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE notification_channel AS ENUM ('FCM', 'SMS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_status AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Templates carry Amharic + English text (drivers are Amharic-first, §1.2).
-- Variables use {{name}} placeholders rendered by the notification service.
CREATE TABLE IF NOT EXISTS notification_templates (
  template_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT NOT NULL UNIQUE CHECK (event_type IN
                 ('TRIP_STARTED','TRIP_ENDED','DRIVER_SEPARATION_TIMER',
                  'GEOFENCE_ENTER','GEOFENCE_EXIT')),
  title_en     TEXT NOT NULL,
  body_en      TEXT NOT NULL,
  title_am     TEXT NOT NULL,
  body_am      TEXT NOT NULL,
  channel      notification_channel NOT NULL DEFAULT 'FCM', -- primary channel
  fallback     notification_channel,                       -- secondary (SMS) when primary unavailable
  active       BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO notification_templates
  (event_type, title_en, body_en, title_am, body_am, channel, fallback)
VALUES
  ('TRIP_STARTED',
   'Trip started', '{{plate}} started a trip.',
   'ጉዞው ጀምሯል', '{{plate}} ጉዞ ጀምሯል።',
   'FCM', NULL),
  ('TRIP_ENDED',
   'Trip ended', '{{plate}} finished a trip. Distance {{distance_km}} km.',
   'ጉዞው አልቋል', '{{plate}} ጉዞ አጠናቋል። ርቀት {{distance_km}} ኪ.።',
   'FCM', NULL),
  ('DRIVER_SEPARATION_TIMER',
   'Driver separation alert', '{{plate}}: driver has been away from the vehicle for over {{minutes}} minutes. Truck last known location recorded.',
   'የአሽከርካሪ መለያየት ማንቂያ', '{{plate}}፦ አሽከርካሪ ከ{{minutes}} ደቂቃ በላይ ከተሽከርካሪው ርቆ ቆይቷል። የመኪናው የመጨረሻ ቦታ ተመዝግቧል።',
   'FCM', 'SMS'),
  ('GEOFENCE_ENTER',
   'Entered zone', '{{plate}} entered {{zone}}.',
   'ወደ ግቢ ገብቷል', '{{plate}} ወደ {{zone}} ገብቷል።',
   'FCM', NULL),
  ('GEOFENCE_EXIT',
   'Left zone', '{{plate}} left {{zone}}.',
   'ከግቢ ወጥቷል', '{{plate}} ከ{{zone}} ወጥቷል።',
   'FCM', NULL)
ON CONFLICT (event_type) DO NOTHING;

-- Delivery ledger. Redacted by design (see header). target_user lets a breach
-- audit answer "which drivers were affected" within the 72h ECA window (§1.7).
CREATE TABLE IF NOT EXISTS notification_log (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      TEXT        NOT NULL,
  dedupe_key      TEXT        NOT NULL,          -- stable logical-event identity (§1.8.3)
  recipient_role  user_role   NOT NULL,           -- who was messaged
  recipient_id    UUID        NOT NULL REFERENCES users(id),
  target_user     UUID        REFERENCES users(id), -- whose trip/personal data triggered it
  channel         notification_channel NOT NULL,
  status          notification_status  NOT NULL,
  provider_msg_id TEXT,                           -- FCM msg id / SMS gateway ref
  error_code      TEXT,                            -- failure class only, no payload
  detail          JSONB        NOT NULL DEFAULT '{}'::jsonb, -- redacted: {trip_id, vehicle_id, template}
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_dedupe ON notification_log (event_type, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_notif_target_time ON notification_log (target_user, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_recipient   ON notification_log (recipient_id, created_at);

-- Separation-timer scan: open incidents not yet notified, oldest first. The
-- partial index keeps the periodic evaluator cheap even as history grows.
CREATE INDEX IF NOT EXISTS idx_separation_unnotified
  ON driver_separation_log (separated_at)
  WHERE returned_at IS NULL AND notified_fleet_manager = false;

-- Reporting reads (§1.9.4 GET /reports/trips ≤ 500 ms p95 for one week/one
-- driver): started_at DESC ordering already uses idx_trips_driver_time; these
-- two accelerate the aggregation joins on events and separations.
CREATE INDEX IF NOT EXISTS idx_trip_events_type_time ON trip_events (event_type, event_timestamp);
CREATE INDEX IF NOT EXISTS idx_separation_driver_time ON driver_separation_log (driver_id, separated_at);
