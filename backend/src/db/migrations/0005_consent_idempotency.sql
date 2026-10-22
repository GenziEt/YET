-- One live consent row per (driver, policy_version): the UNIQUE table constraint
-- uq_consent_driver_version is declared in 0003_consent.sql (needed for ON CONFLICT
-- inference inside that migration's own transaction). This statement is a no-op
-- reconciliation guard for databases created by earlier drafts.
DO $$ BEGIN
  ALTER TABLE consent_records
    ADD CONSTRAINT uq_consent_driver_version UNIQUE (driver_id, policy_version);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;
