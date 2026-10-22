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
