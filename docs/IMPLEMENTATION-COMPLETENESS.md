# YET — Implementation Completeness Report

In-repo register required by the implementation instruction's final gate:
each roadmap requirement → the file(s) and test(s) that satisfy it. A row is
marked **wired** only when the default code path is fully implemented (no
TODO/stub/sandbox/placeholder) AND at least one in-repo test exercises it.
Rows marked **pending verification** have code in place but a check that could
not run in the CI sandbox used so far (noted explicitly).

Status legend: ✅ wired+tested · 🟡 wired, execution pending local SDK/device · ⏳ not yet implemented (later phase)

## Phase 0 — Foundation & compliance skeleton
| Requirement | Code | Tests |
|---|---|---|
| Backend bootstrap wires real routers/guards/services | `backend/src/server.ts`, `backend/src/app.ts` | `backend/tests/*.test.ts` (app-fixture suites) |
| Ordered idempotent migrations from clean DB | `backend/src/db/migrations/0001…0015*.sql` + runner | migration boot in `tests/phase0_gates.test.ts` (DB-gated via `YET_TEST_DB`) |
| Auth/registration/consent/identity endpoints end-to-end | `backend/src/modules/identity/routes.ts`, `consent.ts` | identity/consent suites in `backend/tests/` |
| Consent persistence + collection guard on ingest | consent routes → DB; ingest guard in `modules/ingest/service.ts` | consent-guard tests (`backend/tests/`) |
| Consent policy versioning invalidates prior consent | `consent.ts` policy versions; seed rows in `0013_*.sql` | policy-version tests in `backend/tests/` |
| Fleet/tenant first-class + scoped everywhere | `fleets` table (0001), `fleet_id` on users/drivers/vehicles/records | cross-fleet denial tests (`backend/tests/phase0_gates.test.ts`, DB-gated) |
| Compose free of sandbox references | `infra/docker-compose.yml` | n/a (config review) |
| Secrets hygiene / refuse start without secrets | `backend/src/config/env.ts` fail-fast; `.env.example`; `.env` untracked | env-validation tests in `backend/tests/` |
| Compliance skeleton (ECA, processors, breach, residency) | `backend/src/modules/compliance/*`, `docs/COMPLIANCE-PDPP.md` | compliance config tests in `backend/tests/` |

## Phase 1 — Location ingest pipeline
| Requirement | Code | Tests |
|---|---|---|
| Real GPS plugin wired into default AppRuntime bootstrap | `driver-app/lib/main.dart`, `core/app_runtime.dart`, `lib/platform/*` (geolocator) | `driver-app/test/phase1_ingest_pipeline_test.dart` (FFI SQLite harness) |
| Connectivity/battery plugins wired, telemetry through pipeline | `platform/` collectors (connectivity_plus, battery_plus) | phase1 suite + `sync_worker_test.dart` |
| Local cache survives process death (DAO/schema/migration) | `core/cache/fix_dao.dart`, `sensor_dao.dart` | `phase1_ingest_pipeline_test.dart` bootstrap replay |
| Sync worker: batch/UUID/backoff/429 Retry-After | `core/sync/sync_worker.dart`, `sync_state.dart` | `sync_worker_test.dart`, `sync_state_test.dart`, phase1 429 test |
| Backend batch UUID idempotency + fleet-scoped writes | `modules/ingest/routes.ts`/`service.ts` (`ON CONFLICT DO NOTHING → already_received`) | backend ingest suites incl. duplicate-replay + cross-fleet denial |
| Retention/pruning only after ACK | DAO `pruneAckedOlderThan`/`pruneToStorageBudget` | phase1 pruning assertions |
| Dashboard raw-fix views read real endpoints | `web-dashboard/src/**` raw-fix views | dashboard production build |

## Phase 2 — Sensor fusion & trip engine
| Requirement | Code | Tests |
|---|---|---|
| Accelerometer/gyroscope plugins wired via AppRuntime; sensor DAO+sync complete | `driver-app/lib/features/trip/sensor_collector.dart`, `core/cache/sensor_dao.dart`, `core/app_runtime.dart` | `event_classifier_test.dart` collector-integration group; backend sensor-ingest suites |
| On-device classification with CONFIGURED thresholds (no magic numbers) | `features/trip/event_classifier.dart` (harsh brake/accel peak runs, sustained-gyro turns, variance vibration gate); thresholds from `GET /trips/classification-config` (`backend/src/modules/trip_engine/routes.ts`, `service.ts classificationConfigPayload()`, env in `config/env.ts`) | `backend/tests/trip_classification.test.ts` (boundary below/at/above, cooldown, shuffled-input equivalence, dedupe priority device>fused>GPS, wire-contract key parity); `driver-app/test/event_classifier_test.dart` (mirrored fixtures + resolveThresholds chain fresh→cached→defaults + HttpClassificationConfigSource via MockClient + CachedConfigStore FFI round-trip) |
| Deterministic event-time state machine; in-order == out-of-order reconstruction | `backend/src/modules/trip_engine/state_machine.ts` (`rebuildTrip`) | out-of-order equivalence tests in `trip_state_machine`/`trip_classification` suites |
| Trip start/end/separation/return end-to-end incl. persistence + reporting hooks | trip engine module + ingest hooks | separation/return persistence tests (`backend/tests/`) |
| Last-known-location labeling during separation | dashboard marker logic + trip payload flags | covered by trip listing/report tests |
| Engine-audio: REMOVED from product surface (option b, no dangling refs) | dropped from consent scopes (`identity/routes.ts`, `consent.ts`), ingest enum, migration `0015_remove_audio_surface.sql` (additive; 0004 history immutable), `sensor_dao.dart` allowedKinds, consent UI/repo, ARBs + regenerated `l10n/app_localizations.dart`, `docs/COMPLIANCE-PDPP.md` wording | grep sweep: zero audio references in production paths; l10n completeness check |
| Sensor-batch idempotency (both legs) | client `claimBatch/markBatchAcked/recoverUnackedUploads` + `encodeSensorBatchBody`; server `ingest_batches.batch_id` PK | `event_classifier_test.dart` idempotency group; `backend/tests/sensor_batch_contract.test.ts` (real-route replay → `already_received`) |

### Phase 2 gate status
- `npm run build && npx vitest run` (backend): **clean — 121 passed, 14 skipped** (skips are `YET_TEST_DB`-gated integration suites, documented in-suite).
- Flutter harness: `flutter analyze` / `flutter test` must be executed on a workstation with the Flutter SDK (sandbox has none). Dart test sources compile-checked by inspection only → 🟡 pending local run.
- `sqflite_common_ffi: ^2.3.0` now declared explicitly in `driver-app/pubspec.yaml` dev_dependencies (was previously imported by tests without declaration).

## Phase 3 — Geofences, routing, ETA
✅ Complete at code level. Verified with a live local stack (PostgreSQL 15 + PostGIS 3, Redis 7): all 15 migrations applied to a scratch DB, full backend suite green — **14 files / 170 tests passed, 0 skipped** when `YET_TEST_DB` is set (the two DB-gated suites self-skip only when no database is reachable, which is the documented CI fallback).

| Requirement | Implementation | Tests |
|---|---|---|
| Geofence CRUD with validation, fleet scoping, authorization on every operation | `backend/src/modules/geofence/routes.ts` + `service.ts` (CIRCLE/POLYGON validation, per-op fleet predicates) | `tests/phase0_gates.test.ts` §geofence CRUD/authz (11/11 green, incl. cross-fleet negatives) |
| Deterministic boundary-crossing logic; previously skipped geofence tests enabled and passing | `backend/src/modules/geofence/crossing.ts` — pure `diffTransitions` + `sortFixesChronologically` (event-time determinism vs out-of-order batch arrival) | `tests/crossing_transitions.test.ts` (22 pure-JS tests, run without any DB) + `tests/geofence_crossing.test.ts` (4 DB tests, now executing against PostGIS — latent `afterAll` cleanup bug fixed: `WHERE vehicle_id=$1` → `WHERE id=$1`) |
| OSRM routing client wired to configurable base URL; failures, timeouts, and retries handled; no placeholder responses | `backend/src/modules/osm_gateway/service.ts` — `fetchOsrmWithRetry` (bounded retry, `OSRM_RETRY_ATTEMPTS`/`OSRM_RETRY_BACKOFF_MS` env knobs, network-abort-only; HTTP responses incl. 4xx/5xx and non-`Ok` codes descend the degradation ladder immediately), AbortController timeout, `straightLineFallback` labeled honestly | `tests/route_cache_invalidation.test.ts` §retry+ladder (via injectable fetch seam `setFetchForTesting`) + `tests/osm_gateway.test.ts` (22 tests) |
| Nominatim geocoding gateway with caching and rate-limit compliance | `backend/src/modules/osm_gateway/service.ts` (search/reverse legs, cache + courtesy-rate gating) | `tests/osm_gateway.test.ts` (existing patterns cover the geocode legs) |
| Redis caching fully wired with invalidation rules; consumers read real cache | `backend/src/lib/redis.ts` (`FakeCacheStore` seam, SCAN-based `cacheKeysByPrefix`, `cacheDelMany`) + `osm_gateway/service.ts`: write-through `destIndexKey`/awaited `indexDest`, awaited `pgRouteUpsert`, global route-cache epoch gate (`yet:route:epoch`) so no pre-edit Redis **or** Postgres companion row can serve within its TTL after an edit; `invalidateRoutesForGeofence` supersedes (never deletes) `route_cache` rows for audit integrity; wired `updateGeofence`/`deleteGeofence` → invalidation → `GET /route` write-through | `tests/route_cache_invalidation.test.ts` (12/12: hit/miss/TTL, expired-entry refetch, zone-edit drops exactly indexed entries + fleet-state, precision rule, no-op safety, retry policy) |
| Dashboard route and zone components compile and read real endpoints | `web-dashboard/src/**` route/zone components | `npm run build` clean (dashboard production build) |
| Fleet scoping enforced on every geofence, route, and ETA read/write | `osm_gateway/routes.ts`: destination-geofence `fleet_id` must match claims (ADMIN exempt, fail-closed when token lacks fleet claim); cross-fleet zone ⇒ `404 geofence_not_found` (existence-oracle hidden); `assertTargetInFleet(claims,{vehicleId})` after the DRIVER↔assignment check, denial serialized machine-readable via `deny()` | `tests/phase0_gates.test.ts` §"/route cross-fleet denials": manager-B + fleet-A zone → 404; manager-B + fleet-A vehicle → 403 `cross_fleet_denied`; same-fleet reads allowed |

Honest notes: Nominatim legs are covered by the existing `osm_gateway.test.ts` patterns rather than a dedicated new file; performance/scale scaffolding for cached/uncached route p95 is deferred to Phase 5 per roadmap. The two DB-gated suites (`geofence_crossing`, `phase0_gates`) were executed and passed against the live scratch DB this pass; device/field validation remains out of scope.

## Phase 4 — Driver app hardening
⏳ Amharic full-surface localization audit, offline tile-cache map wiring, feedback flow, assignment gating. Current baseline: real dependencies only (no sandbox overrides in `pubspec.yaml`/lockfile), Amharic ARB present for shipped screens.

## Phase 5 — Reporting, notifications, production readiness
⏳ Reporting endpoints/CSV, FCM + Ethiopian SMS dispatchers, erasure across dependent tables/caches, partitioning migrations, replica read abstraction, 90-day retention job, dashboard offline cache (SW+IndexedDB), performance scaffolding. Not started per phase ordering.

## Cross-cutting final-gate checklist
- [x] No TODO/FIXME/HACK/XXX/stub/mock/sandbox/placeholder in production paths (grep sweeps each session; last sweep clean across Phase 0–2 files).
- [x] No tracked secrets (`.env` gitignored; `.env.example` placeholders only).
- [x] Default entrypoints wire real implementations (location/sensors/connectivity/battery: `main.dart → AppRuntime`; ingest/classification: `server.ts → routers`). Push/SMS/routing/geocoding/tiles land with Phases 3–5.
- [x] Every personal-data endpoint touched in Phases 0–2 has a cross-fleet denial test (DB-gated suites + unit-level guards).
- [ ] Performance scaffolding — Phase 5 deliverable.
- [ ] Local `flutter analyze`/`flutter test` run — required before human device validation begins.
