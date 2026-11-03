#!/usr/bin/env bash
# =============================================================================
# YET — Production map-data readiness gate (Audit P0: "Map infrastructure")
#
# A successful application build does NOT prove OSRM has routing data,
# Nominatim has a geocoded Ethiopian dataset, or tileserver-gl has real
# Ethiopia pmtiles. This script is the deployment-time gate that proves it.
#
#   ./scripts/verify-map-data.sh            # files + live endpoints
#   ./scripts/verify-map-data.sh --offline  # file/dataset checks only (CI)
#
# Exit codes:
#   0  all required datasets provisioned and services answer with data
#   1  a required dataset/service is missing or empty  -> DO NOT LAUNCH PILOT
#   2  argument/environment error
#
# Remediation for any FAIL below: run scripts/import-osm.sh and
# scripts/build-tiles.sh first, then re-run this gate.
# =============================================================================
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OSRM_PROFILE="${OSRM_PROFILE:-driving}"
OFFLINE=0
[[ "${1:-}" == "--offline" ]] && OFFLINE=1

FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

echo "== YET map-data production gate =="
echo

# ---------------------------------------------------------------------------
# [1/4] OSRM routing dataset (files)
# ---------------------------------------------------------------------------
OSRM_DIR="$INFRA_DIR/osrm/data"
OSRM_MAIN="$OSRM_DIR/$OSRM_PROFILE.osrm"
if [[ -f "$OSRM_MAIN" ]]; then
  # An imported region produces multi-hundred-MB .osrm.* sidecar files.
  SIDECARS=$(find "$OSRM_DIR" -maxdepth 1 -name "$OSRM_PROFILE.osrm.*" -size +1M | wc -l | tr -d ' ')
  if [[ "$SIDECARS" -ge 5 ]]; then
    pass "OSRM dataset present ($OSRM_PROFILE.osrm + ${SIDECARS} large sidecar files)"
  else
    fail "OSRM $OSRM_PROFILE.osrm exists but has only ${SIDECARS} large sidecars (<5). Re-run import-osm.sh."
  fi
else
  fail "OSRM dataset missing: $OSRM_MAIN. Run: ./scripts/import-osm.sh ethiopia-latest"
fi

# ---------------------------------------------------------------------------
# [2/4] Tile dataset (real Ethiopia pmtiles, not developer placeholders)
# ---------------------------------------------------------------------------
TILES_FILE="$INFRA_DIR/tiles/data/ethiopia.pmtiles"
PLACEHOLDER_MARKER="$INFRA_DIR/tiles/data/.placeholder"
if [[ -f "$TILES_FILE" ]]; then
  SIZE=$(stat -c%s "$TILES_FILE" 2>/dev/null || stat -f%z "$TILES_FILE")
  if [[ -f "$PLACEHOLDER_MARKER" ]]; then
    fail "tiles/data contains PLACEHOLDER tiles (generate-placeholder-tiles.py output). Forbidden for pilot launch."
  elif [[ "$SIZE" -lt 10485760 ]]; then   # <10MB cannot be a real country extract
    fail "ethiopia.pmtiles is only ${SIZE} bytes — too small to be the Ethiopian extract. Re-run build-tiles.sh."
  else
    pass "Ethiopia pmtiles present ($(( SIZE / 1048576 )) MB, no placeholder marker)"
  fi
else
  fail "tiles/data/ethiopia.pmtiles missing. Run: ./scripts/build-tiles.sh"
fi

# ---------------------------------------------------------------------------
# [3/4] Nominatim dataset (live DB check unless --offline)
# ---------------------------------------------------------------------------
if [[ "$OFFLINE" -eq 0 ]]; then
  if docker compose -f "$INFRA_DIR/docker-compose.yml" exec -T nominatim \
      psql -U nominatim -d nominatim -tAc \
      "SELECT count(*) FROM placex WHERE rank_search<=12 AND country_code='et'" 2>/dev/null | grep -qvE '^0$|^$'; then
    pass "Nominatim contains indexed Ethiopian places"
  else
    fail "Nominatim has no (or zero) indexed Ethiopian places. Import must complete before launch."
  fi

  # -----------------------------------------------------------------------
  # [4/4] Live functional probes — driver-critical capabilities
  # -----------------------------------------------------------------------
  ROUTE_JSON=$(curl -sf --max-time 15 \
    "http://localhost:5000/route/v1/driving/38.7468,9.0307;39.6417,13.0002?overview=false" || true)
  if echo "$ROUTE_JSON" | grep -q '"code":"Ok"'; then
    pass "OSRM answers an Addis Ababa -> Mekelle route with code Ok"
  else
    fail "OSRM live route probe failed (service down or dataset unusable)."
  fi

  GEO_JSON=$(curl -sf --max-time 15 \
    "http://localhost:8080/search?q=Addis%20Ababa&format=json&limit=1" || true)
  if echo "$GEO_JSON" | grep -q '"lat"'; then
    pass "Nominatim geocodes 'Addis Ababa'"
  else
    fail "Nominatim live search probe returned no result."
  fi
else
  echo "SKIP  [3/4] and [4/4] live service probes (--offline)"
fi

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "MAP GATE: READY — datasets verified; safe to declare map services up."
  exit 0
else
  echo "MAP GATE: NOT READY — resolve every FAIL above before pilot launch."
  exit 1
fi
