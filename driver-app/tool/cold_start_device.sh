#!/usr/bin/env bash
# ============================================================================
# Device-side cold-start probe (§1.9.1, STARTUP-OPTIMIZATION.md §5 gate).
#
# The server-side chain (login + first fleet read) is measured by
# backend/scripts/perf/cold_start.mjs. THIS script closes the other half of
# the budget: what the *phone* spends between launcher tap and a drawn frame.
#
#   TTW  = "This Time"  — wall time from am start until activity resume
#   TAT  = "Total Time"  — includes full draw; on Flutter this tracks
#          Displayed/launchState up to the first engine frame
#   TTID = "Displayed" line — time to initial display (the OS splash window
#          already painted; this is when Flutter's first frame replaced it)
#
# Budget (enforced, exit code 1 on breach):
#   TTID  <= COLD_START_BUDGET_MS (default 3000 ms == §1.9.1 3 s budget)
#   TAT   <= TAT_BUDGET_MS        (default 4000 ms margin for warm-up noise)
#
# Method: force-stop -> `am start -W` N times, parse TotalTime/ThisTime/
# Displayed, report p50/p95, compare against budgets. Median-of-N guards
# against one-off page-cache luck; p95 is the gated number, never the mean.
#
# Usage:
#   ./tool/cold_start_device.sh [N]            # device via adb, default pkg
#   PKG=com.example.flavor ./tool/cold_start_device.sh 15
#   ACTIVITY=.MainActivity BUDGET_MS=2500 ./tool/cold_start_device.sh
# ============================================================================
set -euo pipefail

N="${1:-10}"
PKG="${PKG:-com.yet.driver}"
ACTIVITY="${ACTIVITY:-${PKG}/.MainActivity}"
COLD_START_BUDGET_MS="${BUDGET_MS:-3000}"   # §1.9.1: <=3s usable screen
TAT_BUDGET_MS="${TAT_BUDGET_MS:-4000}"
ADB="${ADB:-adb}"

if ! command -v "$ADB" >/dev/null 2>&1; then
  echo "FAIL: adb not found. Install Android platform-tools or set ADB=/path/to/adb" >&2
  exit 2
fi
if ! "$ADB" get-state >/dev/null 2>&1; then
  echo "FAIL: no device connected (adb get-state). Plug the pilot phone with USB debugging." >&2
  exit 2
fi

echo "== YET device cold start: ${N} runs on $("$ADB" shell getprop ro.product.model | tr -d '\r') =="

p95() { # sorted list on stdin -> p95 integer
  sort -n | awk '{a[NR]=$1} END {i=int(NR*0.95); if(i<1)i=1; if(i>NR)i=NR; print a[i]}'
}

ttws=(); tats=(); disp=()
for i in $(seq 1 "$N"); do
  # Cold path: kill the process AND drop its caches' warmth as best we can.
  "$ADB" shell am force-stop "$PKG" >/dev/null
  sleep 2
  out="$("$ADB" shell am start -W -n "$ACTIVITY" | tr -d '\r')"
  ttw=$(echo  "$out" | awk '/ThisTime:/  {print $2}')
  tat=$(echo  "$out" | awk '/TotalTime:/ {print $2}')
  d=$(echo    "$out" | awk '/Displayed:/  {print $2}' | head -1 | sed 's/[^0-9]//g')
  [[ -z "$tat" ]] && { echo "FAIL run $i: unparsable am start output:"; echo "$out"; exit 1; }
  ttws+=("${ttw:-$tat}"); tats+=("$tat"); disp+=("${d:-$tat}")
  printf "  run %2d/%s  TTW=%sms TAT=%sms Displayed=%sms\n" "$i" "$N" "${ttw:-?}" "$tat" "${d:-?}"
done

p95_tat=$(printf '%s\n' "${tats[@]}" | p95)
p95_disp=$(printf '%s\n' "${disp[@]}" | p95)
med_tat=$(printf '%s\n' "${tats[@]}" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}')

echo "----"
echo "TAT       median=${med_tat}ms  p95=${p95_tat}ms  (budget ${TAT_BUDGET_MS}ms)"
echo "Displayed median=-           p95=${p95_disp}ms  (budget ${COLD_START_BUDGET_MS}ms, §1.9.1)"

status=0
if (( p95_disp > COLD_START_BUDGET_MS )); then
  echo "BREACH: cold start to first frame exceeds §1.9.1 3s budget on this device."
  status=1
fi
if (( p95_tat > TAT_BUDGET_MS )); then
  echo "BREACH: total launch time exceeds margin budget."
  status=1
fi
[[ $status -eq 0 ]] && echo "PASS: device-side cold start within budget."
exit $status
