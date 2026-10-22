# YET Offline Contract (v1.0)

Status: **BINDING**. Every engineer implements and tests against this contract.
Source of truth: `Master Implementation.md` §1.8. This document is the operational
restatement; if it ever diverges from code, code review must reconcile them before merge.

Offline capability is not a feature — it is a hard contract between the Flutter client,
the backend, and the web dashboard. Ethiopia's real conditions (intermittent 3G/4G,
remote corridors with no signal, low-end Android devices) make this the single most
important correctness property of the system.

---

## 1. Client sync state machine (§1.8.1)

Every record in the local SQLite cache (GPS fix, sensor event, trip state change) has a
`sync_state`:

```
PENDING ──(worker picks up batch)──► UPLOADING ──(HTTP 2xx + batch ack)──► ACKED ──(prune policy)──► PRUNED
   ▲                                     │
   └──────(any failure / non-2xx)────────┘   with exponential backoff, cap 5 minutes
```

Rules (implemented in `driver-app/lib/core/cache/sync_state.dart`, gated by
`driver-app/test/sync_state_test.dart`):

1. **No data loss.** A record transitions to PRUNED only after an explicit server ACK for
   its `batch_id`. Upload failures return the record to PENDING.
2. **Sync worker triggers:** app foreground, network change to Wi-Fi or 3G+, and every
   60 seconds while a trip is active.
3. **Backoff:** base 5 s, factor 2, cap 300 s. Jitter ±20 % to avoid thundering herd when
   a tower comes back up for a whole fleet at once.
4. **Pruning:** ACKED records are pruned after 7 days **or** when storage exceeds 50 MB,
   whichever comes first.
5. Records never leave PENDING→UPLOADING without a client-generated `batch_id` (UUID v4)
   stamped on every member record, so a crash mid-upload replays atomically.

## 2. Server idempotency (§1.8.2) — hard requirement

- Every ingest batch carries a client-generated `batch_id` (UUID v4).
- Backend table `ingest_batches` has a **unique index on `batch_id`**
  (`backend/src/db/migrations/0004_ingest.sql`).
- Duplicate batch → HTTP 200 with `{ "already_received": true }`. No re-inserts, no
  duplicate trip events.
- Location rows are additionally inserted with `ON CONFLICT DO NOTHING` as a second line
  of defense.
- Without this, a driver who regains signal and retries a batch would create duplicate
  fixes and corrupt every downstream report. This is the only safe offline replay design.

## 3. Trip reconstruction from late-arriving data (§1.8.3)

- Phase 2 Trip Engine is **event-time based**, never arrival-time based. State
  transitions use the fix `timestamp`, not `received_at`.
- A batch arriving 6 hours late causes the Trip Engine to re-evaluate the affected time
  window and upsert trip events idempotently by `(trip_id, event_type, event_timestamp)`.
- **Phase 2 gate test:** upload a batch out of order and confirm trip state is identical
  to in-order upload. Automated in `backend/tests/trip-reconstruction.test.ts` (added in
  Phase 2).

## 4. Offline UX on the web dashboard (§1.8.4)

- Fleet managers also have flaky connections. The dashboard caches last-known fleet state
  in IndexedDB via a service worker.
- On reconnect: refetch and reconcile; never block on a spinner.
- Stale data shows a banner: **"last updated X minutes ago."** Cached state renders
  immediately on load even when offline.

## 5. Sensor event offline durability (§1.8.5)

- Accelerometer/gyroscope events use the **same** SQLite cache and the **same** sync state
  machine as GPS fixes.
- The Phase 1 airplane-mode gate includes sensor events, not just GPS.
- A trip that occurs entirely offline must reconstruct completely — turns, stops, and
  separation events — once data reaches the backend.

## 6. Local storage bounds (§1.8.6)

- Cache ceiling under normal operation: **100 MB**.
- At >80 MB: warn the driver and prioritize uploading GPS fixes over sensor events.
- **GPS fixes are never discarded before upload.** Sensor events may be downsampled if
  storage is critically constrained (>95 MB sustained).
- Constants live in `driver-app/lib/core/config/app_config.dart` — change them there and
  update this document in the same PR.

---

## Field-test gates tied to this contract

| Phase | Gate |
|-------|------|
| 1 | Drive 10 min in airplane mode → restore network → all fixes on dashboard within 60 s. Duplicate batch upload creates no duplicates. |
| 2 | Out-of-order batch upload yields identical trip state to in-order upload. |
| 4 | Pilot drivers deliberately enter no-signal areas; ≥95 % of offline fixes and sensor events reconstruct correctly on the dashboard. |

## Failure playbook

- **Batch stuck in UPLOADING after process death:** on app start, any UPLOADING record
  older than 2× backoff window resets to PENDING (safe because server idempotency makes
  replay free).
- **Server returns 429:** respect `Retry-After`; treat as backoff, never as failure of
  record integrity.
- **Clock skew:** clients send UTC epoch-ms plus device uptime delta; Trip Engine rejects
  future-dated fixes >5 min and flags them for audit rather than silently accepting.
