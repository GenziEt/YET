# YET Architecture Decision Record (Phase 0)

Companion to `Master Implementation.md`. Records what was built, why, and the
pre-agreed triggers that force change. All paths relative to repo root.

## ADR-001 — Microservice-ready modular monolith

**Decision:** One deployable Node.js process (Fastify + TypeScript), organized into
bounded-context module folders so extraction later is a move, not a rewrite.

**Module boundaries (§1.5):**

| # | Module | Owns tables | Phase | Extraction candidate |
|---|--------|-------------|-------|----------------------|
| 1 | Identity & Access | users, vehicles, driver_vehicle_assignments, refresh_tokens, consent_records, audit_log | 0 | — |
| 2 | Ingest | location_fixes, sensor_events, ingest_batches | 0→1 | **First** |
| 3 | Trip Engine | trips, trip_events, driver_separation_log | 2 | — |
| 4 | Geofence & Route | geofences, route_cache | 3 | — |
| 5 | Notification | notification_templates, notification_log | 5 | — |
| 6 | Reporting | none (read-only replica reader) | 5 | **Second** |
| 7 | OSM Gateway | none (wraps OSRM/Nominatim, Redis cache) | 3 | — |

**Extraction rule:** any module with its own DB tables exceeding ~500 lines of business
logic is a candidate. Enforced at code review; LOC tracked per module folder.

## ADR-002 — Fastify over Express

Faster schema-validated routes, first-class async, built-in logging (pino), official
rate-limit/helmet/cors plugins. Native-module-free dependency tree keeps builds simple
on low-resource VPS hosts.

## ADR-003 — PostgreSQL 16 + PostGIS, declarative monthly partitioning (§1.10.1)

- `location_fixes` and `sensor_events` are partitioned by month
  (`PARTITION BY RANGE (fix_timestamp)`); helper logic auto-creates future partitions
  (`0004_ingest.sql`). Time-based partitioning keeps indices small, makes inserts fast,
  and turns expiration into a partition drop instead of row-by-row delete.
- Indices ONLY on `(vehicle_id, fix_timestamp)` and `(driver_id, fix_timestamp)`.
  **No index on raw lat/lng** — bounding-box queries rely on partition pruning first;
  BRIN added only when profiling demands it.
- Batch writes: accumulate ≤500 fixes or 2 s, then one parameterized multi-row INSERT
  `ON CONFLICT DO NOTHING`. Never one INSERT per fix.
- Retention (§1.10.6): raw fixes >90 days downsampled to every 10th fix; aggregates kept.
  Scheduled job lands in Phase 5; the partition layout already supports it.

## ADR-004 — Redis provisioned in Phase 0 (§1.10.2)

Redis runs from day one in `infra/docker-compose.yml` so caching is used, not retrofitted:
OSRM route cache (Phase 3, TTL 5 min), Nominatim geocode cache (Phase 3), dashboard fleet
state (Phase 5, TTL 30 s). `ioredis` is already a backend dependency.

## ADR-005 — Self-hosted OSM stack (§1.6)

- Tiles: tileserver-gl (opt-in compose profile) rendering Ethiopia PBF; nginx serves
  `/tiles/{z}/{x}/{y}.png` with edge cache 24 h, `Cache-Control: public, max-age=86400`
  (§1.9.3). Public OSM tile servers are forbidden in production.
- Routing: OSRM container, Ethiopia + neighbors extract. Refresh documented in
  `infra/scripts/import-osm.sh`.
- Geocoding: Nominatim container, Ethiopia extract.
- Any residual public-OSM call during development must send an identifying User-Agent
  (set in nginx proxy headers), display visible OSM attribution, and honor caching
  headers (min 7 days).
- Flutter client: flutter_map + flutter_map_tile_caching for offline regions.
- Web client: react-leaflet, lazy-loaded chunk.

## ADR-006 — AuthN/AuthZ

JWT access tokens (short-lived) + rotating refresh tokens (`refresh_tokens` table).
Roles: DRIVER, FLEET_MANAGER, ADMIN. Password hashing: node `crypto.scrypt` — zero native
modules, acceptable on low-end VPS. Every personal-data access writes to `audit_log`
(`backend/src/lib/audit.ts`) to satisfy PDPP breach-notification forensics (72 h ECA
window).

## ADR-007 — Read/write separation plan (§1.10.3)

Reporting (Phase 5) reads from a Postgres read replica; Ingest/Trip Engine write to
primary only. Connection config accepts separate `DATABASE_URL` / `REPORT_DATABASE_URL`
env vars so replica cutover is a deployment change, not code.

## ADR-008 — Backpressure (§1.10.4)

- `POST /ingest/locations`: per-driver limit 60 batches/min → 429 + Retry-After; the
  Flutter sync worker treats 429 as backoff, not error (see OFFLINE-CONTRACT.md).
- Global rate limits on auth endpoints enforced at nginx (`infra/nginx.conf`
  `limit_req_zone`) as a second layer.

## Scaling triggers — written down now, acted on later (§1.10.5)

| Trigger | Action |
|---------|--------|
| Sustained ingest > 500 fixes/s | Extract Ingest into its own service (queue-fronted) |
| Postgres primary CPU > 60 % for 10 min | Extract Ingest and/or add read replica |
| Dashboard query latency p95 > 1 s | Extract Reporting onto replica + materialized rollups |
| Cold-start > 3 s on 2 GB RAM target | Audit Flutter main isolate I/O; defer map widget load |

Performance budgets (§1.9) remain the standing gate: POST /ingest/locations (100 fixes)
≤300 ms p95; GET /trips ≤200 ms; GET /route cached ≤50 ms, uncached ≤800 ms; reports
≤500 ms.

## Repository layout

```
/backend        Fastify modular monolith (src/modules/<context>/routes.ts, service.ts)
/driver-app     Flutter (lib/features/<context>/, lib/core/cache/, l10n ARB am+en)
/web-dashboard  React+Vite (lazy leaflet chunk, staleness banner pattern)
/infra          docker-compose (postgres, redis, osrm, nominatim, tiles profile, api, web, nginx)
/docs           THIS — ADRs, OFFLINE-CONTRACT.md, COMPLIANCE-PDPP.md
```

## Monorepo tooling decision

No Nx/Turborepo yet — three projects do not justify the abstraction. Root README
documents per-package commands. Revisit when a shared types package emerges (likely
Phase 2: trip-event schemas shared by backend and both clients).
