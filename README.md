# YET — Logistics Shipment & Vehicle Tracker

Driver-smartphone-based shipment visibility for Ethiopian fleets. The driver's phone is
the sole sensing device. YET is **not** a vehicle anti-theft system; when the driver
leaves the truck with the phone, YET loses real-time truck location — by design.

**Architecture:** Microservice-ready modular monolith (Node.js + TypeScript backend),
Flutter driver app (Android-first), React web dashboard, self-hosted OpenStreetMap stack
(tiles, OSRM routing, Nominatim geocoding).

Full engineering blueprint: see [`Master Implementation.md`](./Master%20Implementation.md).

## Repository layout

```
/backend        Node.js + TypeScript modular monolith (Fastify)
/driver-app     Flutter driver app (Android-first, Amharic + English)
/web-dashboard  React + TypeScript fleet manager dashboard (Leaflet)
/infra          Docker Compose: Postgres(+PostGIS), Redis, OSRM, Nominatim, tile server
/docs           Architecture decision records, offline contract, compliance runbook
```

## Module boundaries (backend)

Bounded contexts, organized for later extraction into services without rewrite:

| # | Module        | Owns tables                                       | Phase |
|---|---------------|---------------------------------------------------|-------|
| 1 | Identity      | users, vehicles, driver_vehicle_assignments, consent_records | 0 |
| 2 | Ingest        | location_fixes, sensor_events, ingest_batches     | 0→1  |
| 3 | Trip Engine   | trips, trip_events, driver_separation_log         | 2    |
| 4 | Geofence/Route| geofences, route_cache                            | 3    |
| 5 | Notification  | notification_templates, notification_log          | 5    |
| 6 | Reporting     | (read-only)                                       | 5    |
| 7 | OSM Gateway   | (wraps OSRM/Nominatim, Redis cache)               | 3    |

Extraction rule: a module with its own tables and >500 lines of business logic is an
extraction candidate. Ingest first, Reporting second. Scaling triggers are documented in
`docs/ARCHITECTURE.md`.

## Quick start (Phase 0)

```bash
# 1. Infrastructure (Postgres+PostGIS, Redis, OSRM, Nominatim)
cd infra
cp .env.example .env            # set POSTGRES_PASSWORD etc.
docker compose up -d

# 2. Import Ethiopia OSM extract (one-time, hours; refresh script provided)
./scripts/import-osm.sh ethiopia-latest

# 3. Backend
cd ../backend
npm install
npm run migrate                 # applies SQL migrations (idempotent)
npm run dev                     # http://localhost:3000  (GET /healthz)

# 4. Web dashboard
cd ../web-dashboard
npm install
npm run dev                     # http://localhost:5173 — Leaflet map on Addis Ababa via self-hosted tiles

# 5. Driver app (requires Flutter SDK on a workstation with Android toolchain)
cd ../driver-app
flutter pub get
flutter run                     # consent screen (am/en) → permissions explainer
```

## Phase 0 acceptance gate

- [x] A driver can install the app, read and accept consent (Amharic/English), and the
      backend records that consent (`POST /v1/consent`, `consent_records` table).
- [x] The web dashboard displays a Leaflet map centered on Addis Ababa without errors.
- [x] The tile server serves valid tiles from the self-hosted instance
      (`GET /tiles/style/bright/{z}/{x}/{y}.png` through the nginx gateway).
- [ ] ECA data-controller registration initiated (process tracked in
      `docs/COMPLIANCE-PDPP.md` — organizational task, started before pilot).

## Phase 3 acceptance gate (geofence, route & ETA)

Run against the live compose stack (Postgres+PostGIS, Redis, OSRM reachable; backend
serving `phase-3-geofence-route` on `healthz`). From `backend/`:

```bash
ADMIN_EMAIL=admin@yet.local ADMIN_PASSWORD=<bootstrap-admin-password> npm run test:geofence
# optional: CACHE_BUDGET_MS=80 npm run test:geofence   # see Gate D note below
```

Prerequisite: bootstrap ADMIN exists (`ADMIN_BOOTSTRAP_EMAIL/PASSWORD` in `.env`);
the script logs in as ADMIN for fleet-level reads and seeds a DRIVER via `/auth/register`.

- [x] **Gate A — geofence CRUD & role guards**: FLEET_MANAGER/ADMIN can create CIRCLE +
      POLYGON zones (PostGIS geometry, GiST-indexed); DRIVER writes → 403; center/radius
      echo contract holds; metadata-only PUT exercises the ring_json update-merge path.
- [x] **Gate B — crossing determinism (§1.8.3)**: synthetic trip replayed chronologically,
      out-of-order, and late-duplicate → GEOFENCE_ENTER/GEOFENCE_EXIT emitted exactly once
      per crossing moment, event sets identical modulo time shift, no multiplication.
      Crossings are globally diffed over fix sequences and attributed to exactly one trip
      (`attributeTrip`) so overlapping trips cannot double-claim an ENTER.
- [x] **Gate C — state matrix**: `GET /geofences/state` returns INSIDE/OUTSIDE per active
      zone for the vehicle and flips correctly after an explicit boundary fix (this is the
      dashboard coloring source).
- [x] **Gate D — route cache budget (§1.9.4)**: `GET /route?destination_geofence_id=`
      resolves the zone centroid as destination; first call populates Redis, second call
      asserts `source === 'redis'` within ≤ 50 ms. Note: this is HTTP wall-clock from the
      script, which includes client overhead — if it runs marginal on loaded hardware,
      raise `CACHE_BUDGET_MS` rather than weakening the Redis-source assertion.
- [x] Unit + Postgres-integration tests: `npm test` (pure geometry/ETA suite always runs;
      `tests/geofence_crossing.test.ts` additionally runs when `YET_TEST_DB` points at a
      migrated scratch DB — covers envelope candidates, status-matrix SQL, circle
      ST_DWithin(geography), polygon ST_Intersects, persist idempotency, window clipping).
- [x] Web dashboard: geofence drawing tool (circle/polygon), inside/outside-colored zone
      layer bound to `/geofences/state`, "Route to destination" panel with ETA + stale
      caveat banner when `eta.stale` (vehicle STOPPED).

## Phase 4 — Driver app hardening & field pilot

Backend serves `phase: 'phase-4-pilot'` on `/healthz`. Operational playbook for the
5–10-truck Ethiopia pilot lives in **`docs/PILOT-RUNBOOK.md`** (phone-based permission
guidance, Samsung/Xiaomi/Oppo/Huawei Doze steps, no-signal drill, feedback triage,
gate-audit checklist).

New ingest surface (all idempotent by client `batch_id`, §1.8.2):
- `POST /ingest/sensors` — accelerometer/gyro/discrete-event batches (§1.8.5), same
  sync-state machine as GPS fixes; client side: `lib/core/cache/sensor_dao.dart` +
  `SyncWorker.runSensorOnce()` (GPS fixes drain first under storage pressure, §1.8.6).
- `POST /ingest/battery` — battery % at trip start/end keyed by
  `(vehicle_id, trip_started_at, phase)`; feeds the drain estimator.
- `POST /ingest/diagnostics` — one-tap driver feedback payload (issue, battery, last-fix
  age, accuracy, network type, pending-sync count) → untriaged queue.

Reporting (Module 6, read-only, FLEET_MANAGER/ADMIN JWT + audit log):
- `GET /reports/pilot?from&to[&driver_id]` — battery verdict vs the **20% target / 25%
  gate**, per-driver medians, upload latency p50/p95, separation counts, sync backlog,
  offline-reconstruction audit (**≥95%** gate), open driver reports. Dashboard binding:
  web-dashboard **Pilot page** (`src/pages/PilotPage.tsx`) renders the PASS/GATE_FAIL
  banner straight from `battery.verdict` and server-provided thresholds.

Gate kernel: `backend/src/modules/trip_engine/pilot_battery.ts` (drain math, charging/
negative exclusions, `judgePilotBattery`, `RECONSTRUCTION_MIN_ACCURACY = 0.95`); unit
tests `backend/tests/pilot_battery.test.ts`; end-to-end replay script
`backend/scripts/integration-pilot.mjs` (`npm run test:pilot`, needs live staging DB).

Driver app (Phase 4 deliverables): Amharic l10n complete for new screens (regenerate via
`tool/gen_l10n.py`), one-tap Start Trip with vehicle-assignment confirmation via `GET /me`
(offline-cached fallback keeps the ≤3-tap rule), offline tile bounding-box pre-download
from the self-hosted tile server only, battery sampling around trips, one-tap feedback
screen, and the Android battery-optimization exemption prompt behind
`yet.dev/battery_exemption` MethodChannel (device-side Kotlin handler; see runbook §2).
Device-only plugins (`battery_plus`, `connectivity_plus`) stay commented out of
`pubspec.yaml` — product code reaches them through typedef seams so tests need no native
binaries. Run `flutter analyze && flutter test` where a Dart SDK exists (not provisioned
in this sandbox).

## Non-negotiable constraints (summary — full text in blueprint §1.2)

1. **Offline-first** — formal Offline Contract, `docs/OFFLINE-CONTRACT.md`. No data loss.
2. **Battery budget** — ≤ ~20%/8h shift via sensor-gated GPS duty cycling.
3. **Low-end Android** — Android 10+, 2GB RAM; no heavy native modules.
4. **Driver UX** — max 3 taps to start a trip; Amharic at launch; no text input while driving.
5. **PDPP No. 1321/2024** — location is personal data; **data sovereignty: all personal
   data stored on servers located in Ethiopia**; ECA breach notification within 72h.

## Production deployment note (data residency)

Personal data collected in Ethiopia must be stored in an Ethiopian data center (§1.7).
Deploy `/infra` on an Ethiopian VPS or local hosting partner. Do not use public OSM tile
servers in production (§1.9.3); the self-hosted tile server behind CDN is mandatory.
