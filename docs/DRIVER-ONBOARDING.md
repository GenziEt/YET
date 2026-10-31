# Driver Onboarding Without Login (Module 1)

Target users are heavy/medium-truck drivers in Ethiopia (high bed, low bed, Isuzu,
FSR/FST…). They hate passwords. YET therefore replaces the conventional driver
login with **one-time registration + phone OTP + persistent device pairing**.
This is a B2B fleet tool, not a consumer ride app: activation and truck/trailer
assignment are **admin-side and mandatory**.

## The flow (driver app)

1. **Phone verification** — `POST /auth/register/otp/request` sends a 6-digit code
   via the Ethiopian SMS gateway (`SMS_GATEWAY_URL`). Codes are stored **hashed,
   in Redis only**, TTL `OTP_TTL_S` (default 300 s), rate-limited to
   `OTP_MAX_PER_PHONE_15MIN` per phone. In dev, `OTP_DEV_ECHO=true` returns the
   code in the response body (boot fails if this is set in production).
2. **Verify** — `POST /auth/register/otp/verify` consumes the code (one-shot;
   replay is rejected) and issues a short-lived **registration ticket**.
3. **One-time registration** — `POST /auth/register` with the ticket + personal,
   licence, vehicle, trailer and (optional) association details. No password is
   ever collected; a DB trigger enforces `users.password_hash IS NULL` for the
   DRIVER role (migration 0016). The device that registers is paired immediately
   (`device_identities`) and the response carries the first access token.
4. **Documents** — `POST /me/documents` (multipart). **DRIVING_LICENSE upload is
   mandatory at registration**; NATIONAL_ID, INSURANCE and OWNERSHIP documents
   are optional/conditional on ownership status. Expiry dates are tracked.
5. **Pending review** — new drivers land in `PENDING_REVIEW` inside the
   *Unassigned Fleet* placeholder tenant until an admin activates them.
6. **Stay signed in** — every launch does a silent `POST /auth/session/refresh`
   with the stored token + stable per-install `device_id`
   (`driver-app/lib/features/auth/device_identity.dart`, a UUID persisted in
   SharedPreferences). A fresh install on a handed-over phone re-pairs via
   `POST /auth/pair-device` after an OTP check. Nothing else: no login screen.

Sessions end only when: an admin revokes the device (lost/stolen phone), the
driver is suspended, or re-verification becomes due (expired licence/document).

## Identity model — driver ≠ truck

Drivers change trucks constantly; the truck plate must never be the account
identity. The primary identity is the **verified phone number + person**:

| Table | Role |
|---|---|
| `users` (role=DRIVER) | permanent person identity, `password_hash` always NULL |
| `driver_profiles` | licence number/class/expiry, association, home base, ownership status |
| `vehicles` / `trailers` | assets; multiple trailers allowed per operation |
| `driver_vehicle_assignments` | time-bound driver↔truck (`unassigned_at` keeps history) |
| `driver_trailer_assignments` | time-bound driver↔trailer |
| `driver_documents` | doc_type, status lifecycle, expiry, reviewer audit trail |
| `device_identities` | per-install credential: `device_id`, platform, last_seen, revoked_at/reason |

A driver updates their own equipment later through the profile section
(`PATCH /me/profile`, `POST /me/vehicles`, `POST /me/trailers`) — self-created
assignments are stamped `created_by_admin = false`.

## Admin side (web dashboard → “Drivers”)

Mandatory B2B path once driver and service taker agree:

1. `GET /admin/drivers?status=PENDING` — review queue (name/phone/licence/plate search).
2. `GET /admin/drivers/:id` — full dossier: documents, truck & trailer history, paired devices.
3. `PATCH /admin/documents/:doc_id/status` — VERIFY / REJECT each document (audited).
4. `GET /admin/documents/:doc_id/file` — view/download the uploaded blob
   (`?download=1` forces attachment). ADMIN sees all documents; FLEET_MANAGER
   only within their own fleet (cross-fleet ⇒ 403). The stored path is
   re-resolved inside `DOC_UPLOAD_DIR` (no traversal), and every open writes a
   `document_file_accessed` audit entry. The dashboard dossier shows View /
   Download buttons per document via this route.
5. `POST /admin/drivers/:id/move` — ADMIN moves the driver from *Unassigned Fleet*
   into the real transport-company tenant (activation).
6. `POST /admin/drivers/:id/assign-vehicle` / `assign-trailer` — the mandatory
   assignment; closes any previous assignment (history kept), stamps
   `created_by_admin = true`, and pulls self-registered assets out of the
   placeholder fleet. Vehicles/trailers come from `GET /admin/vehicles|trailers`.
7. `POST /admin/drivers/:id/suspend` (`{active:true}` reactivates and restores
   the current device pairing so the driver doesn't re-pair).
8. `POST /admin/drivers/:id/revoke-device` — force-logout one install.

Role scoping: `FLEET_MANAGER` sees and acts only within their own fleet
(cross-fleet writes fail closed with 403); fleet moves are `ADMIN`-only. Every
action above writes an audit-log entry.

## Configuration knobs

See `backend/.env.example` → “Driver onboarding without login”:
`OTP_TTL_S`, `OTP_MAX_PER_PHONE_15MIN`, `SMS_GATEWAY_URL`, `SMS_GATEWAY_SENDER`,
`OTP_DEV_ECHO` (dev only), `SEED_DEV_DRIVER` (dev convenience seed).

## Dev smoke test (no SMS provider needed)

```bash
cd backend && OTP_DEV_ECHO=true npm run dev
curl -sX POST localhost:3000/auth/register/otp/request \
  -H 'content-type: application/json' -d '{"phone":"+251911111111"}'   # -> dev_code
# then verify -> ticket -> register (see tests/driver_onboarding.test.ts for
# the exact payload shapes) and watch the driver appear in the dashboard's
# Drivers → Pending review queue.
```

Gate tests: `backend/tests/driver_onboarding.test.ts` (14 gates, run against a
live Postgres via `YET_TEST_DB`).
