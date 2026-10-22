#!/usr/bin/env bash
# =============================================================================
# YET — Ethiopia OSM extract import / refresh (Phase 0 deliverable)
#
# Documents and automates how to get the Ethiopia extract into OSRM and
# Nominatim. Run from the infra/ directory on the Ethiopian host.
#
#   ./scripts/import-osm.sh [extract-name]
#   e.g. ./scripts/import-osm.sh ethiopia-latest
#
# Sources (Geofabrik regional extracts, ODbL licensed — attribution required):
#   https://download.geofabrik.de/africa/ethiopia-latest.osm.pbf
# Daily diffs available under .../ethiopia-updates/ for near-real-time refresh.
#
# NOTE: Eritrea/Djibouti/Sudan/South Sudan extracts can be concatenated with
# osmium/cat if cross-border routing is needed (§1.6: "Ethiopia + neighboring").
# =============================================================================
set -euo pipefail

EXTRACT="${1:-ethiopia-latest}"
BASE_URL="https://download.geofabrik.de/africa"
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OSRM_DIR="$INFRA_DIR/osrm/data"
NOM_DIR="$INFRA_DIR/nominatim/additional_data"
PROFILE="${OSRM_PROFILE:-driving}"

mkdir -p "$OSRM_DIR" "$NOM_DIR"

echo "==> [1/4] Downloading ${EXTRACT}.osm.pbf"
# Idempotent: skip download if file already present with same name.
for DIR in "$OSRM_DIR" "$NOM_DIR"; do
  if [[ ! -s "$DIR/${EXTRACT}.osm.pbf" ]]; then
    curl -fL --retry 5 --retry-delay 10 \
      -o "$DIR/${EXTRACT}.osm.pbf.part" "$BASE_URL/${EXTRACT}.osm.pbf"
    mv "$DIR/${EXTRACT}.osm.pbf.part" "$DIR/${EXTRACT}.osm.pbf"
  fi
done

echo "==> [2/4] Pre-processing for OSRM (${PROFILE} profile)"
docker run --rm -v "$OSRM_DIR:/data" osrm/osrm-backend:latest \
  osrm-extract -p /opt/"$PROFILE"/osrm.ini /data/"$EXTRACT".osm.pbf
docker run --rm -v "$OSRM_DIR:/data" osrm/osrm-backend:latest \
  osrm-partition /data/"$EXTRACT".osrm
docker run --rm -v "$OSRM_DIR:/data" osrm/osrm-backend:latest \
  osrm-customize /data/"$EXTRACT".osrm
# routed container expects /data/driving.osrm — keep filename contract stable:
ln -sf "$EXTRACT".osrm "$OSRM_DIR/$PROFILE.osrm" 2>/dev/null || true

echo "==> [3/4] Importing into Nominatim (first run imports; later runs update)"
if docker compose exec -T nominatim test -f /configured/settings/local.env 2>/dev/null \
   && [[ -n "$(docker compose ps -q nominatim 2>/dev/null)" ]] \
   && docker compose exec -T nominatim psql -U nominatim -d nominatim -tAc \
      "SELECT 1 FROM pg_tables WHERE tablename='place' LIMIT 1" | grep -q 1; then
  echo "    Nominatim already has data — running incremental flat-node update."
  docker compose exec nominatim nominatim --project-dir /data \
    replication --init --no-updates || true
  docker compose exec nominatim nominatim --project-dir /data replication || true
else
  echo "    First import (this takes hours on a 4-core VPS)."
  docker compose up -d nominatim   # mediagis image auto-imports PBF_PATH on first boot
fi

echo "==> [4/4] Restarting OSRM router with new data"
docker compose up -d osrm

echo "Done. Verify:"
echo "  curl -s localhost:5000/status"
echo "  curl -s 'localhost:8081/search?q=Addis+Ababa&format=json&limit=1'"
echo "Refresh cadence: rerun this script weekly (Nominatim step applies diffs automatically)."
