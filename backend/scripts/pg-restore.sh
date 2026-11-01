#!/usr/bin/env bash
# pg-restore.sh — restore a pg-backup.sh dump into a target database.
#
# SAFETY: refuses to run against anything but an explicitly named target and
# requires confirmation when the target database already contains tables.
# Backups are personal data (PDPP): restore only to in-country hosts.
#
# Usage: POSTGRES_DB=yet_restore ./scripts/pg-restore.sh /var/backups/yet-pg/yet-<stamp>.sql.gz
set -euo pipefail

DUMP="${1:?usage: pg-restore.sh <path/to/yet-*.sql.gz>}"
HOST="${POSTGRES_HOST:-127.0.0.1}"
PORT="${POSTGRES_PORT:-5432}"
DB="${POSTGRES_DB:?set POSTGRES_DB (explicit restore target)}"
USER="${POSTGRES_USER:-yet}"

# Verify checksum if the sidecar file exists.
if [[ -f "$DUMP.sha256" ]]; then
  (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256")
fi

export PGPASSWORD="${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"

TABLES=$(psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -At \
  -c "select count(*) from information_schema.tables where table_schema='public'")
if [[ "$TABLES" -gt 0 && "${FORCE_RESTORE:-0}" != "1" ]]; then
  echo "ERROR: target db '$DB' already has $TABLES tables." >&2
  echo "Restore into a fresh database, or set FORCE_RESTORE=1 (drops nothing," >&2
  echo "but statements may conflict). Aborting." >&2
  exit 1
fi

gunzip -c "$DUMP" | psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1
echo "restore ok: $DUMP -> $DB@$HOST:$PORT"
