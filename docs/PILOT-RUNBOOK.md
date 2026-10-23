# YET Phase 4 — Field Pilot Runbook

Operational playbook for the 2-week pilot with 5–10 trucks in Ethiopia. Written to be
read **over the phone** by support staff while a driver holds the handset, and to be
audited at the end of the pilot against the two hard gates:

| Gate | Number | Where measured | Fail action |
|------|--------|----------------|-------------|
| Battery drain | median ≤ **20%** per 8-h shift (target); **> 25%** ⇒ gate fail | `GET /reports/pilot` → `battery.verdict` (Pilot page on dashboard) | Return to Phase 2, tune sensor-gating thresholds (§1.3) before proceeding |
| Offline reconstruction | ≥ **95%** of offline-period GPS fixes & sensor events appear correctly on the dashboard within 5 min of reconnect | `GET /reports/pilot` → `reconstruction_audit.accuracy` (`gate_passed`) | Audit batch_id idempotency (§1.8.2) + sync worker retry taxonomy; fix before scaling fleet |
| Upload integrity (success metric) | ≥ **98%** of collected data uploaded within 24 h | `sync_backlog` + client PENDING counts | Check rate-limit 429 handling, backoff cap (5 min), storage prune order (§1.8.6) |

Backend health must read `phase: 'phase-4-pilot'` on `/healthz` during the pilot.

---

## 1. Pre-departure checklist (per truck, ~15 min, do it at the depot)

1. **App install & consent** — driver opens app, reads the Amharic/English consent
   screen, taps Accept. Verify `POST /v1/consent` recorded server-side
   (`consent_records` table). No consent ⇒ no collection (§1.7 PDPP).
2. **Permissions drill** (see §2 below) — location "Allow all the time", notification
   permission, battery-optimization exemption, auto-start on Xiaomi/Oppo/Huawei.
3. **Offline map download** — on depot Wi-Fi: app → Offline map → *Download pilot
   region* (`TileBounds.addisCorridor`, along the haul route if configured). Wait for
   the completion snackbar. Tiles come ONLY from the self-hosted tile server
   (`AppConfig.tileUrlTemplate`) — public OSM tiles are forbidden in production (§1.6).
4. **One-tap start test** — press Start Trip once; the vehicle-assignment banner
   confirms plate via `GET /me` (or shows the cached/offline variant — starting is
   still allowed with ≤3 taps total, §1.2). End the trip immediately after.
5. **Feedback button smoke test** — tap Feedback → "Other" → Send. The row should
   appear in the dashboard Pilot page "Open driver reports" queue within a minute.
6. **Battery sanity** — note the phone model and starting charge; drains are computed
   from app-reported start/end samples (`POST /ingest/battery`), not driver memory.

## 2. Android permission guidance over the phone

Say each step verbatim; wait for the driver to confirm before moving on. Screens vary
by vendor ROM — jump to §3 if a toggle is missing.

1. Location: Settings → Apps → YET → Permissions → Location → **"Allow all the time"**
   (NOT "While using the app"). Then enable **Use precise location** / "High accuracy".
2. Notifications: allow (the persistent foreground-service notification is required —
   without it Android kills tracking; tell the driver the icon is normal, not a bug).
3. Battery exemption: when the app prompts ("Ignore battery optimizations?"), tap
   **Allow**. If the prompt was dismissed: Settings → Apps → YET → Battery →
   **Unrestricted**. This goes through the `yet.dev/battery_exemption` MethodChannel
   (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`; manifest declares
   `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`). Play-store builds may need the user to
   reach the same setting manually instead — the runbook steps below cover that.
4. Data saver: ask whether the phone restricts background data; if yes, exempt YET.
5. Confirm: driver starts a trip, you watch `GET /ingest/drivers` roster show a fix
   within ~60 s. If not, re-run from step 1 — Doze is the #1 cause of silent loss.

### 3. Vendor-ROM / Doze specifics

All vendors put aggressive task killers *in addition to* stock Doze. Configure ALL of
these or expect phantom "app draining battery"/"GPS not working" feedback reports.

**Samsung (One UI)**
- Settings → Battery → Background usage limits → "Put app to sleep"/"Sleeping apps" →
  remove YET; add YET to **Never sleeping apps**.
- Settings → Apps → YET → Battery → **Unrestricted**.
- Disable "Adaptive battery" for the pilot device if available.

**Xiaomi / Redmi (MIUI/HyperOS)**
- Security app → Battery → App battery saver → YET → **No restrictions**.
- Settings → Apps → YET → Battery saver → Unrestricted; enable **Autostart**.
- Recent-apps screen → long-press YET → lock/tap the padlock icon (survives swipe-kill).
- Settings → Location → enable "Wi-Fi scanning" off/on not needed; keep **GPS high
  accuracy mode** on.

**OPPO / OnePlus / realme (ColorOS)**
- Settings → Battery → App launch management → YET → **Manual management**, enable all
  four toggles (Auto-launch, Secondary launch, Run in background, Open link).
- Settings → Battery → High background power consumption → allow for YET.
- Disable "Optimize battery use" for YET.

**Huawei / Honor (EMUI/Magic OS)**
- Phone Manager (or Battery) → App launch → Manual manage → enable Auto-launch,
  Secondary launch, Run in background for YET.
- Settings → Battery → More battery settings → App launch → YET → **Manage manually**
  (all toggles on).
- Settings → Apps → YET → Battery → **Let this app run in background** = Allow always.

After any ROM change: reboot the phone, start a trip, verify a fix lands server-side.

## 4. No-signal drill (run once per driver week, and mandatory before pilot close)

Purpose: exercise the full Offline Contract (§1.8) in the field, mirroring
`backend/scripts/integration-pilot.mjs` (which replays the same sequence against a
staging backend: airplane-mode buffer → out-of-order re-upload → duplicate-batch ACK
check on `/ingest/locations`, `/ingest/sensors`, `/ingest/battery`,
`/ingest/diagnostics` → pilot-summary assertions).

1. At the depot, driver starts a trip, then turns **airplane mode ON** and drives
   10–15 minutes (include one deliberate stop >60 s so GPS duty-cycles off, and one
   walk-away >50 m from the parked truck to seed a separation event).
2. Note the wall-clock time of reconnection.
3. Airplane mode OFF. Within **60 seconds** the dashboard Raw-fixes view must show all
   buffered fixes (count them vs the app's "X fixes pending sync" going to 0).
4. Sensor events (turn/harsh/vibration-gate) reconstruct too — check the trip detail
   colored polyline: gray stopped segment, red separation segment, markers present.
5. Duplicate-replay safety: force-close and reopen the app immediately after sync;
   no duplicate rows may appear (server answers `already_received: true`, §1.8.2).
6. Record the drill in the pilot log sheet: date, driver, duration offline, fixes
   pending at reconnect, seconds until dashboard complete. Any drill where <95% of
   fixes land within 5 min is a **reconstruction audit failure** — escalate before
   continuing the pilot.

## 5. Feedback triage queue (one-tap reports)

Driver taps Feedback → picks GPS-not-working / battery-drain / sync-stuck / other →
app POSTs a diagnostic payload (`/ingest/diagnostics`: battery %, charging, last-fix
age, accuracy, network type, pending-sync count, trip-active, app version). Triage
daily from the dashboard **Pilot page → Open driver reports**:

| issue | first checks (diagnostic fields) | typical root cause |
|-------|----------------------------------|--------------------|
| gps_not_working | `last_fix_age_s` large, `network_type` irrelevant | permission revoked by ROM update, mock-location off, indoor start — redo §2 |
| battery_drain | `pending_sync_count` huge? `trip_active` stuck true? | sensor gating misfire (Phase 2 tuning), forgotten End-Trip, screen-on navigation |
| sync_stuck | `pending_sync_count` growing, `network_type` cellular | 429 backoff working as designed (wait ≤5 min), captive portal, data-saving mode |
| other | free-form follow-up call | — |

Mark rows triaged in `driver_diagnostics` (`triaged = true`) once resolved; the queue
query only returns untriaged rows. A spike of `battery_drain` reports for one phone
model ⇒ collect its median from `per_driver[]` and compare against the 20/25 numbers
before blaming the driver.

## 6. Weekly pilot review (ops + engineering, 30 min)

1. Screenshot the Pilot page verdict banner for the week (PASS / AT_RISK / GATE_FAIL /
   INSUFFICIENT_DATA — the last means battery sampling wiring broke, check
   `/ingest/battery` arrival).
2. `upload_latency.p95_seconds` trend; `sync_backlog.worst_lag_s` (long tail ⇒ deep
   offline buffers or stuck workers).
3. Separations table: every `open_now` incident older than 45 min should have had a
   fleet-manager notification queued (Module 5 fires in Phase 5; during the pilot the
   dashboard is the alert surface).
4. Reconstruction audit % ≥ 95 with `offline_batches > 0` (if zero, nobody did the
   no-signal drill — schedule it).
5. Adoption: drivers active ÷ fleet size (Part 4 target ≥70% for 4 consecutive weeks).

## 7. Compliance notes during the pilot

- All pilot personal data stays on the Ethiopian-resident Postgres (§3 of
  `docs/COMPLIANCE-PDPP.md`); backups likewise. No CSV exports leave the country.
- Every `GET /reports/pilot` read is audit-logged (actor, window) — sufficient to
  enumerate affected driver IDs inside the 72-h ECA breach-notification window.
- Diagnostic payloads are data-minimized: no audio, no contacts, no photos — exactly
  the schema in `0010_pilot_telemetry.sql`.
- **ECA registration must be CONFIRMED before pilot launch** — tracked in
  `docs/COMPLIANCE-PDPP.md` §6. Piloting with personal-data processing while
  unregistered is a Proclamation violation; treat the checkbox as a launch blocker.

## 8. Gate audit checklist (pilot close-out)

- [ ] Median battery drain ≤ 20%/8h across ≥ MIN_TRIPS_FOR_VERDICT (10) usable trips
      (`battery.trips_measured`); if 20–25% ⇒ AT_RISK, ship Phase 5 with a tuning
      ticket; if > 25% ⇒ **GATE_FAIL — return to Phase 2, do not proceed**.
- [ ] Charging/negative-delta trips excluded from medians (server math; spot-check one
      overnight charge in `per_driver[]`).
- [ ] Reconstruction accuracy ≥ 95% AND ≥ 1 audited offline batch (`offline_sent>0`).
- [ ] ≥ 98% of collected fixes/sensor events uploaded within 24 h (backlog ≈ 0 at
      day-end for every driver).
- [ ] Every no-signal drill logged; failures escalated and re-passed.
- [ ] Feedback queue drained (zero stale untriaged rows > 48 h old).
- [ ] ECA controller registration confirmed; hosting partner processor agreement
      signed (both checkboxes in COMPLIANCE-PDPP §6 flipped before results are used
      commercially).
- [ ] `healthz` phase string and migrations (0010_pilot_telemetry) match the deployed
      build; `npm run test:pilot` green against staging.
