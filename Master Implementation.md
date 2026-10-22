YET — Master Implementation Prompt & Execution Roadmap 
Document type: Engineering blueprint, not code.
Product name: YET ( logistics shipment & vehicle tracker)
Architecture: Microservice-Ready Modular Monolith
Backend: Node.js + TypeScript
Platforms: Flutter driver app (Android-first) + React web dashboard
Maps: OpenStreetMap (self-hosted tiles, OSRM, Nominatim)
Scope constraint: No hardware GPS tracker, no vehicle anti-theft. Pure driver-smartphone tracking.
Revision: Incorporates formal Offline Contract, Performance Budget, and Scalability Guardrails.
Part 1: Master Implementation Prompt
You are the lead architect for YET. Build a logistics tracking platform where the driver’s smartphone is the sole sensing device. The system must function in Ethiopia’s real conditions: intermittent 3G/4G, low-end Android phones, battery anxiety, and drivers who are not power users. Every design decision below is binding unless explicitly revisited.
1.1 Core Product Thesis (Must Be Internalized by Every Engineer)
YET is not a vehicle anti-theft system. It is a driver-and-shipment movement visibility system. When the driver leaves the truck with the phone, YET loses real-time truck location. This is an accepted limitation. The product’s value is: fleet managers see where the driver and shipment are, whether the trip is progressing, and when the driver has separated from the vehicle. Do not attempt to solve anti-theft with software tricks; solve it by recommending a cheap BLE beacon as an optional accessory later, outside this scope.
1.2 Non-Negotiable Technical Constraints
Constraint
Requirement
Offline-first
Driver app must cache location and sensor data locally when network drops. Sync on reconnect. No data loss. Formal contract in §1.8.
Battery budget
Continuous GPS must not exceed ~20% battery per 8-hour shift on a mid-range Android phone. Use sensor-gated GPS duty cycling.
Low-end Android
App must run acceptably on Android 10+ devices with 2GB RAM and slow storage. Avoid heavy native modules.
Driver interaction
Maximum 3 taps to start a trip. Amharic labels required at launch. No text input during driving.
Data privacy
Comply with Ethiopia’s Personal Data Protection Proclamation No. 1321/2024. Location data is personal data. Data sovereignty: personal data collected in Ethiopia must be stored on a server located in Ethiopia . Obtain explicit consent, minimize collection, support erasure requests. Breach notification to Ethiopian Communications Authority (ECA) within 72 hours .

1.3 Smartphone Chip Exploitation Strategy
The driver app must use sensor fusion, not GPS alone. This is the core technical differentiator that makes battery life viable.
Accelerometer (primary gate):
Detect engine vibration and vehicle motion without GPS. A truck at idle or moving produces a low-frequency vibration signature that the accelerometer captures. When vibration drops to background noise for a sustained window, the system suspects “stopped” and can turn GPS off until vibration resumes.
Detect harsh braking and acceleration events by comparing longitudinal acceleration peaks against a calibrated threshold. These events enrich the trip record without continuous GPS sampling.
Gyroscope (turn and orientation detection):
Detect turns by angular velocity exceeding a threshold for a minimum duration. This captures turns even when GPS is stale.
Enable phone-to-vehicle axis alignment: the phone’s orientation relative to the truck is unknown. Use gravity and the driving direction from GPS to calibrate. Store the calibration per trip and per driver-phone placement.
Microphone (engine state confirmation, optional):
Sample audio briefly (1–2 seconds) when accelerometer state is ambiguous. A running truck engine produces a distinct acoustic profile. This is optional and must be user-consented, but it improves stopped/moving classification in the first 60 seconds of a trip before GPS stabilizes.
GPS (ground truth, duty-cycled):
GPS is the expensive sensor. It should be off when the accelerometer confirms stationary for >60 seconds. It should wake on when accelerometer detects sustained vibration change. During active driving, sample at adaptive intervals: 30 seconds at highway speed, 10 seconds in urban/low-speed, 5 seconds when a turn or harsh event is detected.
Use Flutter background location packages that support foreground service with persistent notification, distance filters, and local buffering. Packages like flutter_bg_location demonstrate that battery drain can be held to 2–5% per hour with appropriate distance filters and update intervals . For Android reliability across Doze and vendor ROMs, prefer packages that buffer fixes natively and survive process death .
Cache every GPS fix locally with timestamp. Never discard a fix because upload failed.
Network radio (contextual):
Detect Wi-Fi vs cellular. Do not sync over cellular if the driver has enabled data-saving mode (optional setting). Batch uploads when on Wi-Fi or when buffer exceeds a size threshold.
Use cell tower ID as a coarse location fallback when GPS is unavailable and a fix is urgently needed (e.g., trip start confirmation). This is low-accuracy but prevents a blank map.
1.4 The “Driver Left Vehicle” Scenario — Design Decision
The app cannot know the truck’s location when the driver walks away with the phone. The system must:
Detect separation: When the vehicle is classified as “stopped” (accelerometer silent) and the phone’s GPS coordinates move more than a configurable threshold (default 50 meters) from the stop location while the accelerometer remains silent, flag a driver separation event.
Record both locations: The stop location (last known truck position) and the driver’s current location are both stored. The backend displays them separately on the map.
Start a timer: If separation exceeds a configurable duration (default 45 minutes), notify the fleet manager. The driver may have abandoned the trip, or lunch is taking too long.
Do not claim truck tracking during separation: The dashboard must clearly label the truck marker as “last known location” with a timestamp. Never show a live-tracking indicator for a vehicle whose driver has left.
1.5 Microservice-Ready Modular Monolith — Module Boundaries
The backend is a single deployable Node.js process at launch, but modules are organized with clear bounded contexts so they can be extracted into services later without rewriting.
Module 1: Identity & Access
Driver registration, fleet manager accounts, vehicle assignment.
JWT-based auth. Role: DRIVER, FLEET_MANAGER, ADMIN.
Owns: users, vehicles, driver_vehicle_assignments.
Module 2: Ingest
Receives batched location + sensor payloads from driver app.
Validates, normalizes, writes to time-series store.
Owns: location_fixes, sensor_events, ingest_batches.
Does NOT own trip logic. It only stores raw data.
Module 3: Trip Engine
Consumes ingest data. Determines trip start/stop, driver separation, harsh events, turn counts.
Owns: trips, trip_events, driver_separation_log.
Exposes internal API: “get current trip status for vehicle X.”
Module 4: Geofence & Route
Manages geofences (warehouses, customer sites, restricted zones).
Calls OSRM for route geometry and ETA between current position and destination.
Owns: geofences, route_cache.
External dependency: OSRM instance (self-hosted).
Module 5: Notification
Sends in-app and push notifications for trip start/end, separation alerts, geofence enter/exit.
Owns: notification_templates, notification_log.
Module 6: Reporting
Aggregates trip data for fleet manager dashboard: distance traveled, active driving time, idle time, separation incidents.
Read-only against other modules’ data. Owns no primary tables.
Module 7: OSM Gateway
Wraps all calls to self-hosted Nominatim (geocoding) and OSRM (routing). Caches aggressively.
Ensures User-Agent header compliance for any public OSM service usage .
Extraction rule: Any module that develops its own database tables and exceeds ~500 lines of business logic is a candidate for extraction. Ingest is the first candidate when write volume grows. Reporting is the second.
1.6 OpenStreetMap Stack — Self-Hosted
Component
Choice
Rationale
Map tiles
Self-hosted tile server (tileserver-gl or mapnik) with Ethiopia PBF extract
Public OSM tile servers forbid bulk downloading and prefetch features . Self-hosting is mandatory for a tracking app that needs offline regions and high tile volume.
Routing
OSRM, self-hosted, Ethiopia + neighboring countries OSM extract
Zero per-request cost, full control. OSRM is validated as a low-cost, accurate routing solution for large-scale geospatial data .
Geocoding
Nominatim, self-hosted, Ethiopia extract
Free, OSM-native. Nominatim public API requires a valid User-Agent and rate limiting; self-hosting removes this constraint .
Flutter map client
flutter_map + flutter_map_tile_caching for offline tile regions
Driver app must work offline in remote areas. Self-hosted tiles eliminate dependency on public OSM tile policy.
Web map client
Leaflet (react-leaflet)
Mature, lightweight, OSM-native.

Initial deployment: Use a Docker Compose stack with OSRM and Nominatim on a single mid-sized VPS (4 cores, 16GB RAM). Import Ethiopia OSM extract. Tile server can be added after the first driver pilot if map load performance is acceptable from a cached CDN.
Tile usage policy note: If any public OSM tile service is used during development, the application must send a valid HTTP User-Agent identifying YET, display visible OSM attribution, and cache tiles locally according to HTTP headers (minimum 7 days) . Production must use self-hosted tiles.
1.7 Ethiopia Data Protection Compliance — Built In, Not Bolted On
Ethiopia’s Personal Data Protection Proclamation No. 1321/2024 (in force July 2024) treats location data as personal data. The Ethiopian Communications Authority (ECA) is the supervisory authority . YET must:
Consent screen at first launch: Plain Amharic and English explanation of what is collected (location, motion, optionally audio), why (shipment visibility), who sees it (fleet manager), and how long it is kept. Explicit opt-in before any collection.
Data minimization: Do not collect audio unless the driver enables the optional “improve motion detection” toggle. Do not collect contacts, photos, or other phone data.
Data sovereignty: Personal data collected in Ethiopia must be stored on a server or data center located in Ethiopia . The backend database and any backups containing personal data must reside in an Ethiopian data center. If using cloud infrastructure, select a provider with an Ethiopian region or a local hosting partner.
Erasure path: Driver can request deletion of their historical location data from the app. Backend anonymizes or deletes within 30 days, retaining only trip aggregates for fleet billing if legally required.
Breach notification readiness: Ingest module logs all access. If a breach occurs, the team must notify the ECA within 72 hours of becoming aware . Audit logging must be sufficient to identify affected driver IDs within this window.
Registration: Data controllers and processors must register with the ECA and obtain a license . Begin this process before pilot launch.
1.8 Offline Contract (New — Formalized)
Offline capability is not a feature; it is a hard contract between the Flutter client and the backend. Every engineer must implement and test against this contract.
1.8.1 Client sync state machine (Flutter app)
Every record in the local SQLite cache (GPS fix, sensor event, trip state change) has a sync_state: PENDING → UPLOADING → ACKED → PRUNED. A background sync worker runs on: app foreground, network change to Wi-Fi/3G+, and every 60 seconds while a trip is active. On HTTP failure, record returns to PENDING with exponential backoff (cap 5 minutes). ACKED records are pruned after 7 days or when storage exceeds 50MB, whichever comes first.
1.8.2 Server idempotency (hard requirement)
Every ingest batch carries a client-generated batch_id (UUID v4). Ingest module stores batch_id in a unique index. Duplicate batch → return 200 with already_received: true. This is the only way offline replay is safe. Without this, a driver who regains signal and retries a batch will create duplicate trip events and corrupt reports.
1.8.3 Trip reconstruction from late-arriving data
Phase 2 Trip Engine must be event-time based, not arrival-time based. Trip state transitions use the fix timestamp, not received_at. If a batch arrives 6 hours late, the Trip Engine re-evaluates the affected time window and updates trip events idempotently (upsert by (trip_id, event_type, event_timestamp)). The gate test for Phase 2: “Upload a batch out of order and confirm trip state is identical to in-order upload.”
1.8.4 Offline UX on the web dashboard
Fleet managers in Ethiopia also have flaky connections. The dashboard caches last-known fleet state in IndexedDB via a service worker. On reconnect, it refetches and reconciles. Show a “last updated X minutes ago” banner when data is stale. The dashboard must never display a spinner indefinitely; it must show cached state with a staleness indicator.
1.8.5 Sensor event offline durability
Accelerometer/gyroscope events are written to the same SQLite cache with the same sync state machine as GPS fixes. The Phase 1 airplane-mode gate must be extended to include sensor events, not just GPS. A trip that occurs entirely offline must reconstruct completely—including turns, stops, and separation events—once the data reaches the backend.
1.8.6 Local storage bounds
Flutter app local cache must not exceed 100MB under normal operation. If storage exceeds 80MB, the app warns the driver and prioritizes uploading GPS fixes over sensor events. GPS fixes are never discarded before upload. Sensor events may be downsampled if storage is critically constrained.
1.9 Performance Budget (New — Formalized)
Performance is a feature. These budgets are measured and gated, not aspirational.
1.9.1 Flutter app cold start
Cold start to usable “Start Trip” screen: ≤ 3 seconds on a 2GB RAM Android 10 device.
Map screen first tile render: ≤ 2 seconds with cached tiles; ≤ 5 seconds with network tiles on 3G.
Enforce via: lazy-load map widget only when map tab opened; pre-warm SQLite on splash; avoid synchronous disk I/O on main isolate.
1.9.2 Web dashboard initial load
Time to interactive on a 3G connection: ≤ 5 seconds.
First meaningful map render: ≤ 3 seconds.
Enforce via: code-split by route; Leaflet lazy-loaded; tile server behind CDN with Cache-Control: public, max-age=86400; API responses gzipped; paginated trip lists (default 50 rows).
1.9.3 Tile server strategy
Ethiopia OSM extract rendered with tileserver-gl or mapnik, served behind a CDN (Cloudflare free tier acceptable). Tiles cached at edge for 24 hours. This is the single biggest lever for both app load speed and server load reduction. Public OSM tile servers must not be used in production .
1.9.4 API response budgets
Endpoint
p95 target
POST /ingest/locations (100 fixes)
≤ 300 ms
GET /trips (50 rows)
≤ 200 ms
GET /route (OSRM cached)
≤ 50 ms
GET /route (OSRM uncached)
≤ 800 ms
GET /reports/trips (1 week, 1 driver)
≤ 500 ms

1.10 Scalability Guardrails (New — Formalized)
The monolith must be built to scale without rewrite. These guardrails define how.
1.10.1 Ingest write path
Batch writes: accumulate up to 500 fixes or 2 seconds, whichever first, then single INSERT ... ON CONFLICT DO NOTHING per batch. Never one INSERT per fix.
location_fixes table partitioned by month (Postgres declarative partitioning). Time-based partitioning speeds up inserts by keeping indices smaller and makes data expiration a fast partition drop rather than a row-by-row delete .
Index only on (vehicle_id, fix_timestamp) and (driver_id, fix_timestamp). No index on raw lat/lng.
1.10.2 Caching layer
Redis in front of: OSRM route cache (Phase 3), Nominatim geocode cache (Phase 3), dashboard “fleet current state” query (Phase 5, TTL 30 seconds).
Redis is provisioned in Phase 0 Docker Compose so it is available when needed, not retrofitted.
1.10.3 Read/write separation
Reporting module (Phase 5) reads from a Postgres read replica, never the primary.
Ingest and Trip Engine write to primary only.
1.10.4 Backpressure and rate limiting
Ingest endpoint: per-driver rate limit (60 batches/minute). Excess → 429 with Retry-After. Flutter app respects it via backoff.
Global rate limit at reverse proxy (nginx or Caddy) for auth endpoints.
1.10.5 Scaling triggers (define now, act later)
Extract Ingest into its own service when sustained write volume exceeds 500 fixes/second or Postgres primary CPU exceeds 60% for 10 minutes. Extract Reporting when dashboard query latency p95 exceeds 1 second. These criteria are written down before the pressure arrives so the monolith stays honest.
1.10.6 Data retention as load reduction
Raw location_fixes older than 90 days are downsampled: keep every 10th fix, delete the rest. Trip aggregates and events retained indefinitely. This aligns with PDPP data minimization principles and reduces query load on historical data.
Part 2: Execution Roadmap
No time estimates. Each phase has a definition of done and a gate before the next phase begins.
Phase 0: Foundation & Compliance Skeleton
Goal: A running backend with auth, a Flutter app that launches and shows consent, and a web dashboard that loads an OSM map.
Deliverables:
Monorepo structure: /backend (Node.js + TypeScript, module folders), /driver-app (Flutter), /web-dashboard (React + TypeScript), /infra (Docker Compose for Postgres, Redis, OSRM, Nominatim).
Backend: Express or Fastify server with health endpoint, JWT auth module stub, database connection to PostgreSQL.
Flutter app: Launches, shows PDPP-compliant consent screen in Amharic and English, stores consent locally, shows a “permissions needed” screen explaining why background location is required.
Web dashboard: Loads a Leaflet map centered on Addis Ababa with self-hosted OSM tiles. No data yet.
Infra: OSRM and Nominatim containers running with Ethiopia OSM extract. Redis container provisioned. A script documents how to refresh the extract.
Compliance: ECA data controller registration process initiated.
Gate: A driver can install the app, read and accept consent, and the backend records that consent. The web dashboard displays a map without errors. Tile server responds with valid tiles from the self-hosted instance.
Phase 1: Location Ingest Pipeline (The Spine)
Goal: The driver app can collect GPS fixes, cache them offline, and upload batches to the backend. The dashboard can display raw location history for a driver. Server idempotency and client sync state machine are operational.
Deliverables:
Flutter app:
Foreground service that collects GPS at adaptive intervals.
Local SQLite cache (sqflite or drift) storing every fix with timestamp, lat, lng, speed, accuracy, and a sync_state.
Batch uploader: when network is available, send up to 100 fixes per HTTP request with a batch_id. On failure, exponential backoff. Never delete cached fixes until the server acknowledges them.
Offline Contract §1.8.1 and §1.8.6 implemented.
Simple UI: “Start Trip” button, “End Trip” button, and a counter showing “X fixes pending sync.”
Backend Ingest module:
POST /ingest/locations accepts a batch, validates batch_id against unique index, writes to location_fixes table partitioned by month.
Returns 200 with count of accepted fixes and already_received flag.
Rate limiting per driver (§1.10.4).
Web dashboard:
Table view: select a driver, date range, see raw fixes. Polyline on the map connecting fixes in time order.
Gate: A test driver can drive a route with the phone in airplane mode for 10 minutes, then restore network, and all fixes appear on the dashboard within 60 seconds of reconnection. Duplicate upload of the same batch does not create duplicate records.
Phase 2: Sensor Fusion & Trip State Engine
Goal: The backend determines “moving,” “stopped,” “turning,” and “driver separated” from the ingested data. Trip reconstruction works from out-of-order and late-arriving batches.
Deliverables:
Flutter app:
Collect accelerometer and gyroscope samples at low frequency (10 Hz) when driving is suspected.
Engine vibration gate: When GPS speed is 0 for >30 seconds, sample accelerometer variance. If variance is below threshold, stop GPS collection and enter “low-power stopped” mode. Resume GPS when variance rises.
Turn detection: Gyroscope angular velocity > threshold for >1 second, combined with GPS heading change, records a turn event.
Phone-vehicle alignment: On trip start, use the first 10 seconds of GPS heading and accelerometer gravity vector to estimate phone orientation. Store in trip metadata.
Sensor events written to SQLite with sync_state (§1.8.5).
Backend Trip Engine module:
Consumes location batches and sensor event batches.
Trip state machine: IDLE → STARTED → MOVING ↔ STOPPED → ENDED.
Event-time based processing (§1.8.3). Upsert trip events by (trip_id, event_type, event_timestamp).
Separation detection: When state is STOPPED and a new fix arrives >50 meters from the stop location while accelerometer events are absent, emit DRIVER_SEPARATED with both locations. When driver returns within 30 meters, emit DRIVER_RETURNED.
Store trip summary: start time, end time, distance (filtered haversine), moving duration, stopped duration, separation incidents.
Web dashboard:
Trip list view: vehicle, driver, start/end time, distance, status (active/ended/separation alert).
Trip detail map: polyline colored by state (green moving, gray stopped, red separation segment), markers for separation events.
Gate: A test trip with a deliberate 15-minute driver separation produces a DRIVER_SEPARATED event with both the truck stop location and the driver’s location, and the event clears when the driver returns. A batch uploaded out of order produces the same trip state as in-order upload.
Phase 3: Geofence, Route & ETA
Goal: Fleet managers can define warehouse/customer zones. The dashboard shows whether a vehicle is inside a zone and estimates arrival time to a destination.
Deliverables:
Backend Geofence module:
CRUD for geofences (polygon or circle). Store as PostGIS geometry.
On each location fix ingest, check if the fix crosses a geofence boundary. Emit GEOFENCE_ENTER / GEOFENCE_EXIT events.
Backend OSM Gateway:
GET /route?from=lat,lng&to=lat,lng calls self-hosted OSRM and returns geometry + duration. Cache in Redis for identical origin/destination pairs with 5-minute TTL.
GET /geocode?q=address calls self-hosted Nominatim. Cache in Redis.
Web dashboard:
Geofence drawing tool on Leaflet map.
For an active trip, “Route to destination” panel: select geofence as destination, backend returns OSRM route, dashboard draws it and shows ETA based on current vehicle speed and OSRM duration.
ETA caveat display: If vehicle is in STOPPED state, ETA is marked “stale” and the timestamp of last movement is shown.
Gate: A fleet manager can draw a geofence around a warehouse, assign it as a trip destination, and see an ETA on the dashboard that updates as the vehicle moves. Cached route responses are served from Redis within the API budget (§1.9.4).
Phase 4: Driver App Hardening & Field Pilot
Goal: The app is stable enough for a 2-week pilot with 5–10 real trucks in Ethiopia. Collect real-world battery and data quality metrics. All offline contracts are tested in the field.
Deliverables:
Flutter app:
Amharic UI complete for all driver-facing screens.
One-tap “Start Trip” that confirms vehicle assignment and begins tracking.
Offline map tile cache for pilot region (bounding box downloaded before departure using self-hosted tile server).
Battery optimization: request ignore battery optimizations on Android, guide driver through “Allow all the time” location permission.
Offline Contract §1.8 fully exercised: pilot drivers deliberately enter no-signal areas, and all data reconstructs on the dashboard.
In-app feedback button: driver reports “GPS not working” or “app draining battery” with one tap. Sends diagnostic payload (battery level, GPS accuracy, last fix time, network type, pending sync count).
Backend:
Pilot dashboard: per-driver battery drain estimate (from app-reported battery level at trip start/end), upload latency, separation event count, sync backlog.
Operations:
Support runbook: how to guide a driver through Android permissions over the phone.
Gate: Pilot completes. Battery drain is measured. If median battery drain exceeds 25% per 8-hour shift, return to Phase 2 and tune sensor gating thresholds before proceeding. Offline reconstruction accuracy is audited: ≥ 95% of GPS fixes and sensor events from offline periods appear correctly on the dashboard.
Phase 5: Reporting, Notifications & Production Readiness
Goal: The product is usable by a paying fleet customer. Notifications work. Reports answer the fleet manager’s core questions. All performance and scalability guardrails are measured.
Deliverables:
Backend Notification module:
Push notification via Firebase Cloud Messaging (FCM) to driver and fleet manager apps.
Triggers: trip started, trip ended, driver separation exceeding 45 minutes, geofence enter/exit (if enabled).
Fallback: SMS via a local Ethiopian gateway for fleet managers who do not install the mobile app.
Backend Reporting module:
GET /reports/trips?from=&to=&driver_id= returns aggregated trip summaries. Reads from Postgres read replica (§1.10.3).
GET /reports/separation-incidents returns all separation events with duration and locations.
Web dashboard:
Report views with CSV export.
Fleet overview map: all active vehicles, colored by state (moving/stopped/separation alert). Click to drill into trip detail.
Offline dashboard caching (§1.8.4) with staleness banner.
Compliance:
Data erasure endpoint: DELETE /driver/:id/location-history anonymizes location fixes older than 30 days for that driver, retaining trip aggregates only.
Audit log for all data access by fleet managers.
ECA registration completed. Breach notification procedure documented and tested.
Performance gate: All §1.9 budgets measured and met on a 3G connection and a 2GB RAM Android device.
Scalability gate: Ingest sustained write test at 100 fixes/second with p95 latency under budget. Data retention job (90-day downsampling) scheduled and tested.
Gate: A fleet manager can log in, see all vehicles’ current states, receive a separation alert on their phone, and export a weekly trip report. A driver can request erasure and the backend confirms completion. Performance and scalability budgets pass.
Part 3: What YET Deliberately Does Not Do
Not in scope
Why
Future path
Vehicle anti-theft / real-time truck location when driver is away
Smartphone leaves with driver. Software cannot solve this.
Optional BLE beacon accessory with independent cellular backhaul. Separate product line.
Fuel consumption monitoring
Requires OBD-II or fuel sensor integration. Out of scope for smartphone-only.
OBD-II BLE adapter integration in a later version.
Dashcam / video
Storage and bandwidth prohibitive in Ethiopia. Not core to shipment visibility.
None planned.
Customs / border documentation workflow
Different product domain.
Integrate with third-party platforms later.
Public OSM tile server usage in production
OSM tile policy forbids bulk download and prefetch features required by YET .
Self-hosted tile server is mandatory, not optional.

Part 4: Success Metrics 
These are operational targets, not engineering estimates. They define whether YET is working in the real world.
Battery: Median driver phone battery drain ≤ 20% per 8-hour shift.
Data integrity: ≥ 98% of GPS fixes and sensor events collected by the app are successfully uploaded within 24 hours (including offline periods).
Offline reconstruction: ≥ 95% of offline-collected data reconstructs correctly on the backend within 5 minutes of reconnection.
Separation detection: ≥ 90% of driver-separation events longer than 15 minutes are correctly flagged in a manual audit of 50 trips.
Driver adoption: ≥ 70% of drivers in a pilot fleet use the app for 4 consecutive weeks without support intervention.
Fleet manager value: ≥ 60% of fleet managers in a pilot report that YET answers “where is my shipment” faster than their previous method (phone calls, WhatsApp).
Compliance: ECA registration active. No data breach incidents. Data residency confirmed (all personal data stored on Ethiopian servers).
Final engineering principle for YET: When in doubt, choose the design that saves battery, works offline, and keeps data in Ethiopia. The smartphone’s chips are capable enough; the discipline is in using them sparingly and storing the results.
