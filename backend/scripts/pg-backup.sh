#!/usr/bin/env bash
# pg-backup.sh — nightly logical backup of the YET Logistics Tracker database.
#
# PDPP §1.7 (data residency): backups MUST remain in-country (Ethiopia).
# This script writes to a local, encrypted-at-rest directory on the Addis
# Ababa host (or an in-country object store mounted there). It never ships
# data off the machine. Copy destinations outside Ethiopia are prohibited.
#
# Retention: 30 daily files (personal location data lives in these dumps —
# match the retention policy applied to live tables; see docs/DATA_RETENTION).
#
# Usage:  POSTGRES_HOST=... ./scripts/pg-backup.sh [dest-dir]
set -euo pipefail

HOST="${POSTGRES_HOST:-127.0.0.1}"
PORT="${POSTGRES_PORT:-5432}"
DB="${POSTGRES_DB:-yet}"
USER="${POSTGRES_USER:-yet}"
DEST="${1:-/var/backups/yet-pg}"        # in-country disk only (PDPP §1.7)
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$DEST"
chmod 700 "$DEST"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/yet-${STAMP}.sql.gz"
TMP="$OUT.partial"

export PGPASSWORD="${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"

# -Fc custom format is preferred for pg_restore flexibility; we use plain SQL
# gzipped here so operators can inspect/restore with psql alone if needed.
pg_dump -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" \
  --format=plain --no-owner --no-privileges \
  | gzip -9 > "$TMP"

# Integrity: record SHA-256 next to the dump so restores can verify.
sha256sum "$TMP" | sed "s|${TMP}|$(basename "$OUT")|" > "$OUT.sha256"
mv "$TMP" "$OUT"
chmod 600 "$OUT" "$OUT.sha256"

# Retention sweep (remove dumps older than KEEP_DAYS).
find "$DEST" -name 'yet-*.sql.gz' -mtime "+${KEEP_DAYS}" -delete
find "$DEST" -name 'yet-*.sha256' -mtime "+${KEEP_DAYS}" -delete

echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
