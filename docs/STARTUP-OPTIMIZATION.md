# YET Startup Optimization — Implementation & Execution Plan

**Scope:** Translate the five super-app startup strategies (lazy lifecycle, fake-map
illusion, local-first hydration, binary shrinking, native splash + flat layout) into
concrete, binding engineering work for the YET driver app (Flutter, Android-first),
the web dashboard, and the backend. Budgets come from `Master Implementation.md` §1.9:

| Metric | Budget | Device/network floor |
|---|---|---|
| Cold start → usable "Start Trip" screen | ≤ 3 s | 2 GB RAM, Android 10, slow eMMC |
| Map first tile render (cached tiles) | ≤ 2 s | same device |
| Map first tile render (network, 3G) | ≤ 5 s | 3G RTT ~350 ms |
| Dashboard TTI on 3G | ≤ 5 s | throttled Moto G-class CPU |
| Dashboard first meaningful map render | ≤ 3 s | same |

Every strategy below has (a) the mechanism, (b) concrete implementation in this repo,
(c) how it is measured/gated, and (d) honest status. **Rule of this document: a claim
without a runnable probe is marked PLANNED, never DONE.**

---

## 1. Stripping down the application lifecycle

### 1.1 Mechanism
The fastest code is code that doesn't execute at launch. On Flutter the equivalent of
`Application.onCreate()` trimming is: keep `main()` to microsecond-scale KV reads, defer
all heavy construction until after the first frame, and gate every SDK behind consent.

### 1.2 Implementation in this repo (SHIPPED)
`driver-app/lib/main.dart` implements the phased boot exactly:

1. `main()` does only two tiny SharedPreferences reads (consent flag, auth token) and
   calls `runApp`. No SQLite, no HTTP client pool, no plugin init on the critical path.
2. First frame renders with `_runtime == null`. The route gate
   (`_rootForLocale`) shows consent → permissions → trip home purely from KV state, so
   the usable "Start Trip" screen never waits on disk-heavy components.
3. `Future.microtask(_bootstrapPipeline)` opens SQLite, crash-recovers unacked uploads
   (§1.8.1), constructs `SyncWorker`/`GpsCollector`/`EventClassifier`, then swaps itself
   in via `setState` — the UI is already interactive when this lands.
4. Firebase/FCM is the canonical "secondary SDK deferred" case: `FirebasePushTokenSource`
   is only touched *after* consent + successful bootstrap (`registerFromDevice()` runs
   post-login, off the UI thread). No `Firebase.initializeApp()` in `main()`. Without
   `google-services.json` it degrades to a null token and retries — never blocks boot.
5. Kill-switch pattern (`_pipelineEnabled`): if the composition root throws on a low-end
   device, the app degrades to the proven Phase-0 flow instead of crash-looping. This is
   lazy-init insurance: the heavy pipeline can fail without taking the launcher down.

DI tuning note: there is no DI framework to warm up; the hand-rolled composition root
(`AppRuntime.bootstrap`) *is* the lazy-singleton container — each subsystem is
constructed once, on demand, off the first frame.

### 1.3 Runtime startup profiles (PLANNED — Android side)
Baseline Profiles have no direct Flutter equivalent because Dart AOT-compiles the whole
isolate, but the Android host still JITs framework code (Activity, SplashScreen,
plugin proxies). Planned, in order of value:

- [ ] Add `androidx.profileinstaller:profileinstaller` to `android/app/build.gradle` and
      generate a Baseline Profile covering the first 5 s (launch → trip-home draw) with
      Macrobenchmark + `BaselineProfileGenerator`. Gate: CI job fails if profile regen
      drops TTID (time-to-initial-display) vs. last recorded baseline.
- [ ] Startup Profiles / method-trace ordering as a follow-up once the app ships an
      AndroidX `AppStartup` dependency graph (currently none exists to tune).
- [ ] Measure with `adb shell am start -W` (TTW/TAT) on the pilot device matrix; wire
      results into `backend/scripts/perf/cold_start.mjs` reporting format so both the
      server-side chain (§below) and device-side TTW live in one dashboard.

## 2. The "fake map" illusion

### 2.1 Mechanism
Never let the map engine sit between the touch event and the first useful pixels. Show a
static/cached representation instantly; mount the live engine behind it asynchronously;
swap without a visual seam.

### 2.2 Implementation in this repo
- **SHIPPED (same trick, cheaper medium):** YET's first screen is deliberately NOT a map.
  The cold-start surface is the text/button Trip Home screen; the offline map
  (`OfflineMapScreen`) is lazy-loaded only when opened, per §1.9.1 enforcement
  ("lazy-load map widget only when map tab opened"). This removes the entire
  vector-engine/tile-decode cost from the launch path.
- **SHIPPED (tile mirror):** `PilotService.prefetchTiles` writes
  `{app-support}/offline_tiles/{z}/{x}/{y}.png`; `OfflineTileImage.filePathFor` resolves
  the identical layout read-only. Offline, the map is literally served from the on-disk
  snapshot — zero network, zero engine warm-up stalls.
- **PLANNED (last-known-location placeholder):** render the cached snapshot as the map's
  initial viewport before `flutter_map` mounts:
  - [ ] Persist the last fix (lat/lng/zoom/bearing + PNG thumbnail of the surrounding
        prefetch region) on trip end into the existing SQLite file (new `map_snapshot`
        table, v3 migration in `AppRuntime.bootstrap`).
  - [ ] On map open: draw the thumbnail + static markers immediately (<50 ms), start the
        tile layer in parallel, cross-fade after the first tile batch paints (~250 ms
        fade). Acceptance: no blank/gray frame captured in a 30 fps screen recording.

## 3. Local-first hydration (zero network blocks)

### 3.1 Mechanism
First paint must be a function of disk state only. Network refines, never gates.

### 3.2 Implementation in this repo (SHIPPED)
- All trip-critical state hydrates from local stores at boot: consent flags and token
  from SharedPreferences; pending-sync count from `SyncWorker.refreshPendingCount()`
  (indexed SQLite count, milliseconds); classification thresholds from
  `CachedConfigStore` (server calibration cached in SQLite so offline trips reuse the
  latest values — §1.8 fallback).
- Vehicle assignment uses the optimistic-cache pattern: `AssignmentCheck.offlineCached`
  allows trip start from the cached assignment when the network is down; a fresh unknown
  with no cache blocks honestly rather than spinning. This is the ride-hailing "show the
  last session instantly" pattern applied to fleet state.
- GPS fixes/sensor events are write-through to SQLite with a sync state machine
  (`recoverUnackedUploads` before any read) — the UI never awaits an upload to proceed.
- Dashboard mirrors the contract: service-worker IndexedDB cache of last fleet state plus
  a "last updated X minutes ago" staleness banner (§1.8.4); infinite spinners are banned.

### 3.3 Geohash-style density caching (ADAPTED, PLANNED)
YET has no passenger fleet, but the identical pattern applies to *truck-density near
warehouses* for the dashboard heat layer:
- [ ] Backend: aggregate active vehicles per geohash-6 into a Redis hash refreshed by the
      ingest path (write-behind, no extra query load); expose `GET /reports/fleet-density?bbox=`.
- [ ] Dashboard: cache the last density payload in IndexedDB keyed by viewport geohash;
      paint approximate circles instantly, refine on WebSocket/poll update. Budget:
      density paint ≤ 100 ms after viewport change, network-independent.

## 4. Binary and compilation shrinking

### 4.1 Mechanism
Smaller APK/AOT image ⇒ less I/O page-in at launch, faster class/Dex loading, smaller
download for pilot fleets over 3G.

### 4.2 Implementation plan (PLANNED — build config, no code risk)
Flutter already R8-shrinks release builds; we make it explicit and measurable:
- [ ] `android/app/build.gradle`: enable `minifyEnabled true`, `shrinkResources true` for
      `release`, add ProGuard rules for geolocator/battery_plus reflective entry points;
      verify foreground-service survival on the test matrix before pilot rollout.
- [ ] Build with `--split-debug-info --tree-shake-icons --obfuscate`; record AOT snapshot
      size per release in CI (fail on >5% growth without sign-off).
- [ ] ABI splits (`--split-per-abi`) so pilots download arm64-only (~40% smaller).
- [ ] Dynamic Feature Delivery analogue: YET's "modules" (pilot telemetry, feedback,
      offline map) are separate Flutter features compiled into one image — DFD is not
      viable on Flutter stable today. Substitute: keep `pubspec.yaml` lean (firebase_core
      + firebase_messaging are the only heavyweight deps; both lazy-init, §1.2.4) and
      revisit deferred-components once `flutter build appbundle --deferred-components`
      matures. Documented as an accepted gap, not silently skipped.

## 5. Layout flattening and native splash screens

### 5.1 Native-driven splash (SHIPPED, partially)
- The manifest launches `.MainActivity` with `@style/LaunchTheme` + `NormalTheme` swap —
  the OS draws the window background before the Dart isolate starts. That is the correct
  "system-layer splash" mechanism on Flutter.
- **SHIPPED this pass (Android 12 SplashScreen API, zero-plugin, pure XML):**
  - `res/values/colors.xml` — brand green `#14532D` (matches the ColorScheme seed
    in `main.dart`).
  - `res/values/styles.xml` — `LaunchTheme` + `NormalTheme` now carry
    `android:windowBackground → @drawable/splash_background` (flat single-node
    layer list, zero decode cost). Same background on both themes makes the
    Launch→Normal swap visually seamless even before the engine's first paint.
  - `res/values-v31/styles.xml` — on API 31+ the same `LaunchTheme` resolves to
    `windowSplashScreenBackground` + `windowSplashScreenAnimatedIcon`, so the OS
    composites the branded icon during process fork. No `flutter_native_splash`
    dependency, no runtime Kotlin code on the launch path.
  - `res/drawable/splash_icon.xml` — vector mark (no PNG decode). Replace with
    final brand asset when design signs off; geometry only, never raster.
  - Verified: no Dart-side splash widget exists; the frames between touch and
    first Flutter draw belong entirely to the OS. NOTE: this partial checkout
    has no Gradle project files (`build.gradle` absent), so resource wiring is
    inspection/XML-parse verified; first real `flutter build apk` must confirm
    resource merge (cheap check: `aapt dump --values resources`).

### 5.2 Flat layouts (SHIPPED + gated this pass)
- Trip Home / Consent / Permissions screens avoid deep nesting; Material widgets here are
  cheap. Compose/SwiftUI single-pass drawing does not apply (no Compose in this app);
  the Flutter analogue enforced is: no `LayoutBuilder`+`CustomMultiChildLayout` chains
  on the boot path, const constructors everywhere under `main.dart`'s first-frame subtree.
- **SHIPPED:** `driver-app/test/startup_flattening_test.dart` — two regression gates:
  1. *Local-first hydration:* pumps the exact cold-start shape (`runtime: null`, empty
     in-memory SQLite worker whose uploader THROWS if touched) and asserts ONE pump
     already yields an enabled `START TRIP` button and zero `CircularProgressIndicator`.
  2. *Flattening budget:* measures root-to-leaf element depth of the trip-home frame
     and fails past 14 levels (baseline + margin), guarding against nesting creep that
     would add layout passes to the launch critical path.
  Run with `flutter test test/startup_flattening_test.dart` (Flutter SDK absent from
  this sandbox — same pending-verification note as the push work in
  IMPLEMENTATION-COMPLETENESS.md; CI runs it on every driver-app PR).

---

## Measurement & gating (execution backbone)

Runnable probes already exist in `backend/scripts/perf/`:

| Probe | Covers | Budget knobs |
|---|---|---|
| `cold_start.mjs` | login p95 ≤ 1200 ms, first fleet-state read ≤ 800 ms | env vars |
| `tile_render.mjs` | cold tile p95 ≤ 400 ms, warm (nginx 24 h cache) ≤ 80 ms | env vars |
| `lighthouse.tti.cjs` | dashboard TTI ≤ 5 s @ 3G throttle | Lighthouse CI |
| `battery_pilot.mjs`, `route_p95.mjs`, `report_p95.mjs`, `upload_integrity.mjs` | adjacent §1.9 budgets | env vars |

Gaps to close in this area (status honest):
- [x] **SHIPPED this pass:** device-side TTW/TAT/Displayed capture —
      `driver-app/tool/cold_start_device.sh` (force-stop → `am start -W` × N,
      p95 of TAT and Displayed vs. §1.9.1 budgets; exit 1 on breach). Requires a
      real device via adb, so it runs on the pilot bench / device-farm CI job,
      not in this sandbox. Report format mirrors `cold_start.mjs` so both halves
      of the budget land in one gate.
- [ ] CI workflow that runs all perf probes against a throwaway docker-compose
      stack and fails on budget breach (today they are manual gates — tracked in
      IMPLEMENTATION-COMPLETENESS.md line 86).

## Execution timeline (single program, 4 weeks)

| Week | Deliverables | Exit gate |
|---|---|---|
| W1 | Splash XML themes (v31), R8/shrink config + ABI splits, pubspec dep audit | APK ≤ target size; `am start -W` TAT improvement recorded on test phone |
| W2 | Baseline Profile generation + Macrobenchmark CI job; map snapshot persistence (SQLite v3 migration) | TTID regression gate green on CI emulator |
| W3 | Cross-fade map mount; geohash density endpoint + IndexedDB cache | 30 fps recording shows no blank map frame; density paints ≤100 ms offline |
| W4 | Perf-probe CI wiring (all §1.9 scripts, fail-on-breach); runbook updates | Full budget table passes on pilot-device matrix + 3G throttle lab |

**Non-negotiable acceptance:** every §1.9 row above must have a passing probe run
attached to the release PR. Aspirational claims are removed from docs unless a probe
backs them (this doc follows that rule: SHIPPED/PLANNED labels throughout).
