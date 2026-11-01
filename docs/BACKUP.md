# Database Backup & Restore (YET Logistics Tracker)

**Scope:** PostgreSQL (`yet` database) in `infra/docker-compose.yml` on the Addis Ababa host.
**Legal constraint:** PDPP §1.7 — **backups must remain in-country (Ethiopia)**. Never replicate dumps to foreign object storage or off-site drives that leave the country without a registered cross-border transfer. The residency allowlist enforced at boot in `backend/src/config/env.ts` applies to backup destinations as well: keep them on the in-country host or an in-country mounted volume.

## Scripts

| Script | Purpose |
|---|---|
| `backend/scripts/pg-backup.sh [dest-dir]` | Nightly `pg_dump` → gzipped SQL + SHA-256 sidecar, 30-day retention sweep. Default dest `/var/backups/yet-pg` (mode 700). |
| `backend/scripts/pg-restore.sh <dump.sql.gz>` | Verifies checksum, refuses to restore into a non-empty DB unless `FORCE_RESTORE=1`, then loads with `ON_ERROR_STOP=1`. |

Both read connection settings from the standard env vars used by compose:
`POSTGRES_HOST/PORT/DB/USER/PASSWORD`.

## Schedule (nightly)

The compose file already mounts a cron directory for retention jobs; add the backup alongside it on the host:

```cron
# /etc/cron.d/yet-backup  (host crontab, user postgres-capable account)
# Nightly 02:30 UTC+3 after the retention job window; logs kept local.
30 2 * * * yetops POSTGRES_PASSWORD=$(cat /run/secrets/pg_backup_pass) \
    /opt/yet/backend/scripts/pg-backup.sh /var/backups/yet-pg >> /var/log/yet-backup.log 2>&1
```

- `DEST` dir must be on an **encrypted-at-rest** volume (LUKS or provider disk encryption within Ethiopia).
- Retention: 30 daily dumps (aligned with location-data retention). Older files are swept automatically.

## Restore procedure (drill quarterly)

1. Provision a fresh target DB on the same in-country host:
   `CREATE DATABASE yet_restore ...;`
2. `POSTGRES_DB=yet_restore backend/scripts/pg-restore.sh /var/backups/yet-pg/yet-<stamp>.sql.gz`
3. Run smoke checks (`/healthz`, `/readyz`, login flow against the restored schema).
4. Record the drill in the pilot runbook (date, dump id, duration, verifier).

Point-in-time recovery beyond the last nightly dump requires WAL archiving; if RPO < 24 h becomes a launch requirement, enable `archive_mode` on the Postgres container and keep WAL segments in the same in-country directory tree (not covered by these scripts yet — tracked as a follow-up before scaling past pilot).

## What is NOT backed up here

- Redis: OTPs/tickets/route cache are ephemeral by design (fail-closed contract); no restore story needed.
- Driver-app uploads under `backend/var`: personal data — included via scheduled filesystem snapshot of `backend/var` to the same encrypted in-country destination (operator task, see pilot runbook).
