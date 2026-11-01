-- 0017: JWT revocation before expiry (production-readiness audit, P1 "no revocation path").
--
-- Problem: access tokens live JWT_ACCESS_TTL (default 12 h). Before this migration a
-- 12 h token stayed cryptographically valid after device un-pairing or account
-- suspension until it expired. The onboarding authGuard already re-checks users /
-- fleets per request (fail-closed), but the other module guards (ingest, trip,
-- geofence, osm, reporting, notification, identity /auth/me) verified only the
-- signature — so a revoked-but-unexpired token could keep calling those surfaces.
--
-- Design: monotonic per-user token version stamped into every JWT at mint time
-- ("tv" claim). Revocation events bump users.token_version; guards compare the
-- claim against the live row and reject stale tokens with 401 `token_revoked`.
-- Cost: one indexed PK read per authenticated request (same pattern as the
-- onboarding guard's existing per-request users lookup).
--
-- Bump points (see identity/routes.ts + identity/onboarding.ts):
--   - password change / staff login? no — only explicit revocation events:
--   - POST /me/devices/revoke            (driver signs out an install)
--   - POST /admin/drivers/:id/suspend    (is_active=false path)
--   - POST /admin/drivers/:id/revoke-device (lost/stolen phone)
--   - fleet suspension is already covered by per-request fleet checks where they
--     exist; bumping here too would require fleet-wide UPDATE joins — deferred.

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Keep the epoch monotonic for application-driven writes too. The bump helper
-- (lib/revocation.ts) uses an atomic UPDATE, so BEFORE triggers never fire for
-- it; this guard only catches hand-written SQL / admin tools that would lower
-- the version and resurrect already-revoked tokens (fail-closed posture).
CREATE OR REPLACE FUNCTION trg_users_token_version_min() RETURNS trigger AS $$
BEGIN
  IF NEW.token_version < OLD.token_version THEN
    RAISE EXCEPTION 'token_version is monotonic: % -> % not allowed', OLD.token_version, NEW.token_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_token_version_min ON users;
CREATE TRIGGER users_token_version_min
  BEFORE UPDATE OF token_version ON users
  FOR EACH ROW EXECUTE FUNCTION trg_users_token_version_min();
