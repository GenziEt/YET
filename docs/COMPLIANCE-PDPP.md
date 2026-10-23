# YET Compliance Runbook — Ethiopia PDPP (Proclamation No. 1321/2024)

Location data is personal data under Ethiopian law. The Ethiopian Communications
Authority (ECA) is the supervisory authority. This runbook is operational: it maps each
legal obligation to code, process, and owner. **Data sovereignty is a deployment
requirement, not a feature.**

---

## 1. Lawful basis & consent (§1.7, Phase 0 gate item)

- **Consent screen at first launch**, plain Amharic and English: what is collected
  (location, motion; audio only if driver opts in), why (shipment visibility), who sees
  it (assigned fleet manager), how long it is kept.
- Explicit opt-in **before any collection**. Decline = app does nothing but show the
  decline screen; no background service starts.
- Implementation: `driver-app/lib/features/consent/*` (UI + repository), backend
  `POST /consent` writes `consent_records` (policy_version, locale, granted_scopes,
  device_id, timestamp). Idempotent upsert keyed on (user, policy_version, device).
  `GET /consent/current` returns whether re-consent is required when policy version
  changes. Ingest endpoints reject requests from users without active consent for the
  requested scopes.
- If a driver's offline consent acceptance hasn't synced yet, the client refuses to
  collect location until local consent exists AND syncs the record before first batch.

## 2. Data minimization

- Audio is NOT collected unless the driver enables the optional "improve motion
  detection" toggle (default OFF).
- No contacts, photos, SMS, or other phone data — ever. Enforced by dependency review:
  the Flutter pubspec must never gain permission_.* packages beyond location, activity
  recognition (sensors), notifications, battery-exemption.
- Raw fixes retained 90 days, then downsampled to every 10th fix (§1.10.6); trip
  aggregates retained per contract/billing need.

## 3. Data sovereignty (hard constraint)

- All personal data (Postgres primary, replicas, backups, logs containing identifiers)
  resides on servers located in Ethiopia — local hosting partner or cloud provider with
  an Ethiopian region.
- `infra/docker-compose.yml` header warning; deployment checklist below. Volume paths,
  backup destinations (`pg_dump` targets), and log shippers must all be Ethiopian soil.
- Cross-border transfer requires ECA-approved adequacy or explicit safeguards — not
  planned; avoid entirely.

**Deployment checklist (run before every production deploy):**
- [ ] Host location confirmed in Ethiopia (provider invoice/peering proof on file)
- [ ] Backups encrypted (age/gpg) and stored in-country; restore tested
- [ ] TLS terminated at nginx with current cipher suite; HSTS on
- [ ] No telemetry SDKs phoning foreign endpoints (audit pubspec + npm deps)

## 4. Erasure path

- Driver can request deletion of historical location data from the app (Phase 5 UI;
  endpoint contract fixed now): `DELETE /driver/:id/location-history`.
- Backend deletes/anonymizes raw fixes older than 30 days for that driver within 30 days
  of request, retaining only trip aggregates where legally required for billing.
- Every erasure action writes an `audit_log` row (who requested, scope, completed_at).

## 5. Breach notification readiness (72 h to ECA)

On becoming aware of a breach, the team must notify the ECA within 72 hours. Procedure:

1. **Triage (0–6 h):** contain; snapshot `audit_log` and access logs.
2. **Scope (6–24 h):** query audit trail to identify affected driver IDs:
   ```sql
   SELECT DISTINCT subject_user_id FROM audit_log
   WHERE action IN ('READ_LOCATIONS','EXPORT','LOGIN') AND created_at > :breach_start;
   ```
   Audit logging MUST be sufficient to answer "which drivers' data was touched" inside
   this window — that is why every personal-data read is logged (`backend/src/lib/audit.ts`).
3. **Notify (≤72 h):** ECA notification with nature of breach, categories/number of
   data subjects, measures taken. Template maintained at `docs/incidents/` (create on
   first incident drill).
4. **Inform drivers** whose data was exposed, in Amharic and English.
5. Post-incident review → update this runbook.

**Annual requirement:** tabletop breach drill; time the audit query above (<1 h target).

## 6. Registration & licensing

- Data controllers and processors must register with the ECA and obtain a license.
- Status tracker:
  - [x] Phase 0: registration process initiated (paperwork filed)
  - [ ] Before pilot launch: controller registration confirmed — **LAUNCH BLOCKER for
        the Phase 4 field pilot** (see `docs/PILOT-RUNBOOK.md` §7/§8). Tracking owner:
        founder/legal lead. Engineering hands over: data-flow diagram (docs/), retention
        schedule (§2), sub-processor list, and the audit-log evidence that every
        `/reports/pilot` read is attributable inside the 72-h ECA window. Flip this box
        only on receipt of the ECA confirmation letter/reference number.
  - [ ] Before pilot launch: processor agreement signed with hosting partner
  - [ ] Phase 5: license number displayed in app privacy screen
- Owner: founder/legal lead. Engineering provides: data-flow diagram (this repo docs/),
  retention schedule (§2), sub-processor list (hosting, SMS gateway, FCM).

## 7. Transparency artifacts shipped in-product

- Privacy notice text lives in `driver-app/lib/l10n/app_am.arb` / `app_en.arb` — the
  Amharic copy is reviewed by a native speaker before each release (no machine-only
  translations for legal text).
- Dashboard shows OSM attribution (legal + tile-policy requirement) and a "who can see
  my data" page for drivers via fleet-manager account.

## Open items carried into later phases

| Item | Phase |
|------|-------|
| Erasure endpoint implementation | 5 |
| Fleet-manager access audit log viewer | 5 |
| SMS/Fcm sub-processor DPA signatures | 5 |
| ECA license number in privacy screen | 5 |
