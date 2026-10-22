#!/usr/bin/env bash
# YET — build Ethiopia vector tiles (pmtiles) for tileserver-gl (§1.6).
# Pipeline: osmium extract -> tilemaker (MBTiles/pmtiles) -> served by tiles container.
# Deferred until after first pilot IF raw serving performance is acceptable; script
# documents the path so it is one command when needed.
set -euo pipefail
IN="${1:-osrm/data/ethiopia-latest.osm.pbf}"
OUT="tiles/data/ethiopia.pmtiles"
mkdir -p tiles/data
# tilemaker with a driving-ish style; tune maxzoom to 14 for storage on low-end devices.
docker run --rm -v "$PWD:/data" -w /data systemli/tilemaker \
  tilemaker --input "$IN" --output "$OUT" --store --maxzoom 14
echo "Built $OUT. Start tile server: docker compose --profile tiles up -d tiles"
