#!/usr/bin/env bash
# YET Phase 0 acceptance-gate smoke test (run against a live stack with DB migrated).
#   Gate item: "driver accepts consent and the backend records that consent."
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"

echo "== health =="
curl -sf "$BASE/healthz" | tee /dev/stderr | grep -q '"db":"ok"'

echo "== login (bootstrap admin) =="
TOKEN=$(curl -sf -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d "{\"identifier\":\"${ADMIN_EMAIL:-admin@yet.local}\",\"password\":\"${ADMIN_PW:-change-me}\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
echo "token acquired (${#TOKEN} chars)"

echo "== record consent =="
curl -sf -X POST "$BASE/consent" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"policy_version":"consent-v1","locale":"am","granted_scopes":["location","motion"],"device_id":"smoke-device"}' \
  | grep -q consent_id && echo "consent recorded OK"

echo "== duplicate consent is idempotent =="
curl -sf -X POST "$BASE/consent" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"policy_version":"consent-v1","locale":"am","granted_scopes":["location","motion"],"device_id":"smoke-device"}' \
  | grep -q consent_id && echo "idempotent OK"

echo "== ingest rejects request without token =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ingest/locations" -H 'content-type: application/json' -d '{}')
[[ "$code" == "401" ]] && echo "401 without token OK"

echo "ALL PHASE-0 SMOKE CHECKS PASSED"
