-- ============================================================================
-- 0012: Module 5 — push-token storage + notification status transitions (Phase 5)
--
-- user_push_tokens: FCM registration tokens per user/device. PDPP §1.7 data
-- minimization: an FCM token is a delivery handle, NOT location data — it is
-- still personal data (device identifier), so it lives on its own table with a
-- clear erasure path (DELETE /driver/:id/location-history and account deletion
-- can target it explicitly) instead of widening the core users row.
--
--   * token is UNIQUE globally: if a phone is handed between drivers, the new
--     owner's registration UPSERTS the same row and moves the token (last_seen_at
--     records the takeover). Nobody else keeps a stale claim on it — that is what
--     prevents alert leakage across reassignments.
--   * locale snapshot at registration time lets the dispatcher render Amharic vs
--     English per recipient without joining users on every send (§1.2 Amharic-first).
--
-- notification_log.status already includes QUEUED/SENT/FAILED/SKIPPED (migration
-- 0011); here we add the transition index the dispatcher pickup loop needs and a
-- CHECK keeping sent_at consistent with terminal statuses.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_push_tokens (
  token_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         TEXT NOT NULL UNIQUE,             -- FCM registration token (v1)
  platform      TEXT NOT NULL DEFAULT 'android' CHECK (platform IN ('android','ios','web')),
  device_id     TEXT,                             -- app-side install UUID (matches users.device_id)
  locale        TEXT CHECK (locale IN ('en','am')),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON user_push_tokens (user_id);

-- Dispatcher pickup worker scans QUEUED rows oldest-first (§dispatchers.ts).
CREATE INDEX IF NOT EXISTS idx_notif_queued
  ON notification_log (created_at) WHERE status = 'QUEUED';

-- sent_at must exist exactly for delivered/attempted messages; QUEUED never has it.
DO $$ BEGIN
  ALTER TABLE notification_log
    ADD CONSTRAINT chk_notif_sent_at CHECK (
      (status IN ('SENT','FAILED') AND sent_at IS NOT NULL)
      OR (status IN ('QUEUED','SKIPPED') AND sent_at IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
