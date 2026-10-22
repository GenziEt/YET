-- ============================================================================
-- 0003: PDPP consent records (§1.7) — Phase 0 gate artifact
-- "A driver can install the app, read and accept consent, and the backend
--  records that consent."
-- ============================================================================

CREATE TABLE IF NOT EXISTS consent_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id       UUID NOT NULL REFERENCES users(id),
  policy_version  TEXT NOT NULL,                  -- e.g. "consent-v1" — lets us re-prompt on change
  locale          TEXT NOT NULL CHECK (locale IN ('en','am')),
  granted_scopes  TEXT[] NOT NULL,                -- minimal set: {location, motion}; optional: {audio}
  device_id       TEXT,
  app_version     TEXT,
  ip              INET,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ                    -- erasure/withdrawal path (§1.7)
);
CREATE INDEX IF NOT EXISTS idx_consent_driver ON consent_records(driver_id, granted_at DESC);
