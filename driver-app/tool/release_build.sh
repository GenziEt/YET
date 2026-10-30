# ============================================================================
# YET driver-app — RELEASE BUILD SCRIPT (STARTUP-OPTIMIZATION.md §5, P1/P6)
#
# Single reproducible entry point for shipping the pilot APK/AAB. Encodes
# every flag the "buttery smooth" contract depends on, so nobody hand-types
# a flutter build command and silently drops one:
#
#   * --split-per-abi / AAB abi splits  → arm64-only download for the fleet
#     (app/build.gradle also enables this via splits{}, kept here as belt &
#     braces for tooling that ignores gradle splits).
#   * --dart-define PIPELINE_ENABLED    → startup kill-switch (§5.2); MUST be
#     'true' for pilot builds (const-folded in AOT, zero startup cost).
#   * --dart-define API_BASE_URL / TILE_BASE_URL → gateway + self-hosted tile
#     origin baked at compile time (§5.4 handshake tier).
#   * dart-obfuscate                    → smaller strings, harder reversing.
#   * --tree-shake-icons                → icon font subsetted to glyphs used.
#   * key.properties presence check     → app/build.gradle degrades to an
#     UNSIGNED artifact without it; we fail loudly instead of shipping one.
#
# Prerequisites (you own these, see docs/STARTUP-OPTIMIZATION.md §5.3):
#   - driver-app/android/key.properties  (storePassword/keyPassword/
#     storeFile/keyAlias — file is git-ignored, keystore lives off-repo)
#   - Flutter SDK on PATH, JDK 17
#
# Usage:
#   ./tool/release_build.sh            # APK (direct sideload to pilot trucks)
#   ./tool/release_build.sh aab        # Play-track bundle
#   API=https://api.yet.et TILE=https://tiles.yet.et ./tool/release_build.sh
# ============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # → driver-app/

ARTIFACT="${1:-apk}"

# ---- Pilot defaults (override via env when the gateway hostnames change) ---
API_BASE_URL="${API:-https://api.yet.et}"
TILE_BASE_URL="${TILE:-https://tiles.yet.et}"
PIPELINE_ENABLED="${PIPELINE:-true}"

KEY_PROPS="android/key.properties"
if [ ! -f "$KEY_PROPS" ]; then
  echo "ERROR: $KEY_PROPS missing — release would build UNSIGNED." >&2
  echo "Create it (git-ignored) with:" >&2
  echo "  storePassword=…  keyPassword=…  storeFile=/absolute/path/yet-release.jks  keyAlias=yet" >&2
  exit 1
fi
# The gradle script resolves storeFile from key.properties; verify the actual
# keystore exists before burning a 5-minute build.
KS_LINE=$(grep -E '^\s*storeFile\s*=' "$KEY_PROPS" | tail -1 || true)
KS_PATH="${KS_LINE#*=}"
KS_PATH="${KS_PATH%\"}"; KS_PATH="${KS_PATH#\"}"
KS_PATH="${KS_PATH%\'}"; KS_PATH="${KS_PATH#\'}"
KS_PATH="$(echo "$KS_PATH" | tr -d '[:space:]')"
if [ -n "$KS_PATH" ] && [ ! -f "$KS_PATH" ]; then
  echo "ERROR: keystore '$KS_PATH' from $KEY_PROPS not found." >&2
  exit 1
fi

DEFINES=(
  "--dart-define=API_BASE_URL=$API_BASE_URL"
  "--dart-define=TILE_BASE_URL=$TILE_BASE_URL"
  "--dart-define=PIPELINE_ENABLED=$PIPELINE_ENABLED"
)

COMMON=(--release --obfuscate --split-debug-info=build/symbols --tree-shake-icons)

echo "==> Building $ARTIFACT: API=$API_BASE_URL TILES=$TILE_BASE_URL PIPELINE=$PIPELINE_ENABLED"
case "$ARTIFACT" in
  apk)
    flutter build apk "${COMMON[@]}" --split-per-abi "${DEFINES[@]}"
    OUT=build/app/outputs/flutter-apk
    ;;
  aab)
    flutter build appbundle "${COMMON[@]}" "${DEFINES[@]}"
    OUT=build/app/outputs/bundle/release
    ;;
  *)
    echo "usage: $0 [apk|aab]" >&2
    exit 2
    ;;
esac

# ---- Post-build sanity gates (mirror CI .github/workflows/startup-gates.yml)
if [ "$ARTIFACT" = "apk" ]; then
  ARM=$(find "$OUT" -name '*arm64-v8a-release.apk' | head -1)
  [ -n "$ARM" ] || { echo "ERROR: arm64 split missing — ABI splits regressed." >&2; exit 1; }
  SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $(du -k "$ARM" | cut -f1)/1024}")
  BUDGET="${APK_BUDGET_MB:-24}"
  echo "==> arm64 APK: ${SIZE_MB} MB (budget ${BUDGET} MB)"
  awk "BEGIN {exit !($SIZE_MB <= $BUDGET)}" || {
    echo "ERROR: size budget breached — investigate before distributing." >&2; exit 1; }
  # Verify signing actually happened (debug-signed release = distribution bug).
  if command -v apksigner >/dev/null 2>&1; then
    apksigner verify --print-certs "$ARM" >/dev/null || {
      echo "ERROR: artifact is not signed with the release key." >&2; exit 1; }
  fi
  echo "==> OK: $ARM"
else
  echo "==> OK: $OUT/app-release.aab"
fi
echo "Symbols (for crash deobfuscation) kept in build/symbols — archive them with the release."
