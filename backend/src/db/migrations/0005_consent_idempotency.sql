-- One live consent row per (driver, policy_version) so re-acceptance updates rather
-- than duplicates history (needed by POST /consent ON CONFLICT clause).
CREATE UNIQUE INDEX IF NOT EXISTS uq_consent_driver_version
  ON consent_records (driver_id, policy_version) WHERE revoked_at IS NULL;
