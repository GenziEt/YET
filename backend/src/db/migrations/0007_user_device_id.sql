-- ============================================================================
-- 0007: Phase 1 — driver device pairing
-- users.device_id: stable per-install UUID sent by the Flutter app at
-- /me/bootstrap. Lets ops recognize a re-pairing and supports erasure-request
-- identity lookups (PDPP §1.7) without storing any additional phone data.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_device_id ON users (device_id) WHERE device_id IS NOT NULL;
