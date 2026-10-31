import { API_BASE } from '../config';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Minimal typed fetch wrapper. Phase 1+ endpoints land here as they ship. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('yet_token'); // §1.8: dashboard is online-first w/ cache
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) throw new ApiError(res.status, `API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

/** POST /auth/login — stores the JWT for subsequent calls (Phase 3 write actions). */
export async function login(identifier: string, password: string): Promise<{ role: string }> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) throw new ApiError(res.status, `login -> ${res.status}`);
  const body = await res.json() as { access_token: string; role: string };
  localStorage.setItem('yet_token', body.access_token);
  localStorage.setItem('yet_role', body.role);
  return { role: body.role };
}

export const logout = () => {
  localStorage.removeItem('yet_token');
  localStorage.removeItem('yet_role');
};

export const currentRole = () => localStorage.getItem('yet_role');
export const hasToken = () => !!localStorage.getItem('yet_token');

export interface HealthResponse {
  service: string; version: string; phase: string; db: 'ok' | 'degraded'; time: string;
}
export const getHealth = () => api<HealthResponse>('/healthz');

/* ---------------------------------------------------------------------------
 * Phase 1 — Ingest read side (Module 2). Bindings mirror backend contracts:
 *   GET /ingest/drivers?since=ISO      -> roster for the driver selector
 *   GET /ingest/fixes?driver_id&from&to -> raw fixes ordered by EVENT time (§1.8.3)
 * Every /ingest/fixes read is audit-logged server-side (PDPP §1.7).
 * ------------------------------------------------------------------------- */

export interface DriverRosterEntry {
  driver_id: string;
  full_name: string;
  plate_number: string | null;
  vehicle_id: string | null;
  last_fix_at: string;
}

export interface LocationFixRow {
  fix_timestamp: string; // event time, ISO — polyline/table ordering key
  lat: number;
  lng: number;
  speed_mps: number | null;
  accuracy_m: number | null;
  heading_deg: number | null;
  provider: string | null;
  batch_id: string;      // provenance: which upload carried this fix
}

export const getDrivers = (sinceIso?: string) =>
  api<{ drivers: DriverRosterEntry[] }>(
    `/ingest/drivers${sinceIso ? `?since=${encodeURIComponent(sinceIso)}` : ''}`,
  );

export const getFixes = (driverId: string, fromIso: string, toIso: string, limit = 2000) =>
  api<{ driver_id: string; count: number; fixes: LocationFixRow[] }>(
    `/ingest/fixes?driver_id=${encodeURIComponent(driverId)}` +
      `&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&limit=${limit}`,
  );

/* ---------------------------------------------------------------------------
 * Phase 3 — Geofence & Route (Modules 4 + 7). Contracts mirror the backend:
 *   GET/POST/PUT/DELETE /geofences            CRUD (write = FLEET_MANAGER/ADMIN)
 *   GET /geofences/state?vehicle_id=          inside/outside vs latest fix
 *   GET /route?from&to[&vehicle_id][&destination_geofence_id]  OSRM + ETA
 * Ring format is [lat,lng][] CLOSED (same as Leaflet's own convention), so the
 * drawing tool posts its editor output almost verbatim.
 * ------------------------------------------------------------------------- */

export type GeofenceKind = 'CIRCLE' | 'POLYGON';
export type GeofenceCategory = 'WAREHOUSE' | 'CUSTOMER_SITE' | 'RESTRICTED_ZONE' | 'DEPOT' | 'OTHER';

export interface GeofenceDto {
  geofence_id: string;
  name: string;
  kind: GeofenceKind;
  category: GeofenceCategory;
  active: boolean;
  center: { lat: number; lng: number } | null;
  radius_m: number | null;
  ring: [number, number][] | null; // closed [lat,lng][] for POLYGON redraw
  created_at: string;
  updated_at: string;
}

export interface GeofenceCreateBody {
  kind: GeofenceKind;
  name: string;
  category: GeofenceCategory;
  center?: { lat: number; lng: number };
  radius_m?: number;
  ring?: [number, number][];
}

export interface VehicleGeofenceState {
  vehicle_id: string;
  last_fix_at: string | null;
  inside: { geofence_id: string; name: string; category: string }[];
  states: { geofence_id: string; name: string; kind: GeofenceKind; inside: boolean }[];
}

export interface EtaInfo {
  eta_seconds: number;
  eta_method: 'osrm' | 'speed_adjusted' | 'fallback_avg_speed';
  stale: boolean;              // STOPPED ⇒ dashboard shows the caveat banner (§Phase 3)
  last_movement_at: string | null;
  state: string | null;        // trip state at compute time (MOVING/STOPPED/...)
}

export interface RouteResponse {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  distance_m: number;
  duration_s: number;
  geometry: [number, number][]; // decoded [lat,lng][] — ready for Leaflet Polyline
  source: 'redis' | 'postgres' | 'osrm' | 'stale_redis' | 'fallback_straight';
  cached_at: string;
  fallback: boolean;
  eta: EtaInfo | null;
}

export const listGeofences = (includeInactive = false) =>
  api<{ count: number; geofences: GeofenceDto[] }>(`/geofences${includeInactive ? '?include_inactive=true' : ''}`);

export const createGeofence = (body: GeofenceCreateBody) =>
  api<GeofenceDto>('/geofences', { method: 'POST', body: JSON.stringify(body) });

export const updateGeofence = (id: string, body: Partial<GeofenceCreateBody> & { active?: boolean }) =>
  api<GeofenceDto>(`/geofences/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });

export const deleteGeofence = (id: string) =>
  api<{ deleted: boolean }>(`/geofences/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getVehicleGeofenceState = (vehicleId: string) =>
  api<VehicleGeofenceState>(`/geofences/state?vehicle_id=${encodeURIComponent(vehicleId)}`);

export const getRoute = (opts: {
  from: [number, number]; to?: [number, number];
  vehicleId?: string; destinationGeofenceId?: string;
}) => {
  const q = new URLSearchParams({ from: `${opts.from[0]},${opts.from[1]}` });
  if (opts.to) q.set('to', `${opts.to[0]},${opts.to[1]}`);
  if (opts.vehicleId) q.set('vehicle_id', opts.vehicleId);
  if (opts.destinationGeofenceId) q.set('destination_geofence_id', opts.destinationGeofenceId);
  return api<RouteResponse>(`/route?${q.toString()}`);
};

/* ---------------------------------------------------------------------------
 * Phase 4 — Pilot telemetry (Module 6 Reporting, read-only §1.5). Contract
 * mirrors backend/src/modules/reporting/pilot_service.ts getPilotSummary():
 *   GET /reports/pilot?from&to[&driver_id]  (FLEET_MANAGER/ADMIN JWT + audit)
 * Battery verdicts mirror trip_engine/pilot_battery.ts judgePilotBattery:
 *   PASS | BETWEEN_TARGET_AND_GATE | GATE_FAIL | INSUFFICIENT_DATA
 * Thresholds come FROM the server payload — never hardcode 20/25/0.95 here.
 * ------------------------------------------------------------------------- */

export type PilotBatteryVerdict = 'PASS' | 'BETWEEN_TARGET_AND_GATE' | 'GATE_FAIL' | 'INSUFFICIENT_DATA';

export interface PilotReportDto {
  window: { from: string; to: string };
  thresholds: {
    target_pct_per_8h: number;            // 20 (§Part 4 success metric)
    gate_max_pct_per_8h: number;          // 25 (Phase 4 gate ⇒ back to P2)
    reconstruction_min_accuracy: number;  // 0.95
  };
  battery: {
    verdict: PilotBatteryVerdict;
    median_pct_per_8h: number | null;
    p90_pct_per_8h: number | null;
    target_met: boolean;
    gate_failed: boolean;
    trips_measured: number;
    trips_with_samples: number;
  };
  per_driver: {
    driver_id: string;
    driver_name: string | null;
    plate_number: string | null;
    trips_measured: number;
    median_pct_per_8h: number | null;
  }[];
  upload_latency: { p50_seconds: number | null; p95_seconds: number | null; batches: number };
  separations: {
    vehicle_id: string;
    plate_number: string | null;
    incidents: number;
    open_now: number;
    avg_minutes: number | null;
  }[];
  sync_backlog: { late_fixes: number; total_fixes: number; worst_lag_s: number };
  reconstruction_audit: {
    offline_sent: number;
    offline_stored: number;
    offline_batches: number;
    accuracy: number;      // stored/sent over offline-period batches
    gate_passed: boolean;  // accuracy >= 0.95
  };
  open_driver_reports: {
    diag_id: string;
    batch_id: string;
    driver_id: string;
    driver_name: string;
    reported_at: string;
    issue: string;         // gps_not_working | battery_drain | sync_stuck | other
    battery_pct: number | null;
    last_fix_age_s: number | null;
    last_accuracy_m: number | null;
    network_type: string | null;
    pending_sync_count: number | null;
    trip_active: boolean | null;
    app_version: string | null;
  }[];
}

export const getPilotReport = (opts: { fromIso: string; toIso: string; driverId?: string }) => {
  const q = new URLSearchParams({ from: opts.fromIso, to: opts.toIso });
  if (opts.driverId) q.set('driver_id', opts.driverId);
  return api<PilotReportDto>(`/reports/pilot?${q.toString()}`);
};

/* ---------------------------------------------------------------------------
 * Phase 5 — Fleet reporting (Module 6, B/D). Contracts mirror
 * backend/src/modules/reporting/{service,kernel}.ts. All three require a
 * FLEET_MANAGER/ADMIN JWT (login() above); every read is audited server-side.
 * ------------------------------------------------------------------------- */

export interface TripReportRow {
  trip_id: string;
  driver_id: string;
  plate_number: string | null;
  started_at: string;   // ISO event time
  ended_at: string | null;
  state: 'STARTED' | 'MOVING' | 'STOPPED' | 'ENDED';
  distance_m: number;
  moving_duration_s: number;
  stopped_duration_s: number;
  turn_count: number;
  harsh_event_count: number;
}

export interface TripReportDto {
  window: { from: string; to: string };
  driver_id: string | null;
  summary: {
    trip_count: number; total_distance_km: number; total_moving_s: number;
    total_stopped_s: number; turn_count: number; harsh_event_count: number;
  };
  weeks: { week_start: string; trips: number; distance_km: number }[];
  trips: TripReportRow[];
}

export const getTripReport = (opts: { fromIso: string; toIso: string; driverId?: string }) => {
  const q = new URLSearchParams({ from: opts.fromIso, to: opts.toIso });
  if (opts.driverId) q.set('driver_id', opts.driverId);
  return api<TripReportDto>(`/reports/trips?${q.toString()}`);
};

export interface SeparationIncidentDto {
  separation_id: string;
  trip_id: string;
  vehicle_id: string;
  driver_id: string;
  driver_name: string | null;
  plate_number: string | null;
  status: string;
  separated_at: string;
  returned_at: string | null;
  duration_min: number | null;
  truck_stop_lat: number | null;
  truck_stop_lng: number | null;
  distance_m: number | null;
  notified_fleet_manager: boolean;
  /** §1.4: snapshot of where the TRUCK was when separation began — never live. */
  truck_last_known_location: { lat: number | null; lng: number | null; label: 'last_known' };
}

export interface SeparationsDto {
  window: { from: string; to: string };
  driver_id: string | null;
  count: number;
  incidents: SeparationIncidentDto[];
}

export const getSeparations = (opts: { fromIso: string; toIso: string; driverId?: string; openOnly?: boolean }) => {
  const q = new URLSearchParams({ from: opts.fromIso, to: opts.toIso });
  if (opts.driverId) q.set('driver_id', opts.driverId);
  if (opts.openOnly) q.set('open_only', 'true');
  return api<SeparationsDto>(`/reports/separations?${q.toString()}`);
};

export interface FleetVehicleStateDto {
  vehicle_id: string;
  plate_number: string | null;
  driver_id: string | null;
  driver_name: string | null;
  last_fix: { at: string; lat: number; lng: number; speed_mps: number | null; accuracy_m: number | null } | null;
  trip: {
    vehicle_id: string; trip_id: string; driver_id: string; state: string;
    started_at: string; last_activity_at: string; separation_open: boolean;
    separated_minutes: number | null; notified: boolean;
  } | null;
  /** Age of last_fix vs the cache instant — drives the §1.4 honesty labeling. */
  last_fix_age_s: number | null;
  is_live: boolean;
}

export interface FleetStateDto {
  generated_at: string;
  vehicles: FleetVehicleStateDto[];
  counts: { total: number; on_trip: number; separated_open: number; stale: number; offline: number };
  cached: boolean;
  replica_lag_s: number | null;
  live_window_s: number;
}

/** GET /reports/fleet-state — poll this (server TTL is 30s; polling faster is harmless). */
export const getFleetState = (refresh = false) =>
  api<FleetStateDto>(`/reports/fleet-state${refresh ? '?refresh=1' : ''}`);

/** Notification delivery ledger (§Phase 5 A) — managers only, audited. */
export interface NotificationLogRow {
  notification_id: string;
  event_type: string;
  dedupe_key: string;
  recipient_role: string;
  recipient_id: string;
  target_user: string | null;
  channel: string;
  status: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';
  provider_msg_id: string | null;
  error_code: string | null;
  created_at: string;
  sent_at: string | null;
}

export const getNotificationLog = (opts?: { eventType?: string; status?: string; limit?: number }) => {
  const q = new URLSearchParams();
  if (opts?.eventType) q.set('event_type', opts.eventType);
  if (opts?.status) q.set('status', opts.status);
  if (opts?.limit) q.set('limit', String(opts.limit));
  const qs = q.toString();
  return api<{ count: number; notifications: NotificationLogRow[] }>(`/notifications/log${qs ? `?${qs}` : ''}`);
};

/* Trip Engine reads used by the Phase 3 route panel (active trips selector). */
export interface TripSummary {
  trip_id: string;
  vehicle_id: string;
  driver_id: string;
  started_at: string;
  ended_at: string | null;
  state: 'STARTED' | 'MOVING' | 'STOPPED' | 'ENDED';
  distance_m: number;
}

export const getActiveTrips = () =>
  api<{ count: number; trips: TripSummary[] }>('/trips?status=active&limit=50');

/* ---------------------------------------------------------------------------
 * Module 1 — Driver onboarding & admin assignment (no-login drivers).
 * Contracts mirror backend src/modules/identity/onboarding.ts:
 *   GET  /admin/drivers?status&q          review queue / roster
 *   GET  /admin/drivers/:id               full dossier (docs, history, devices)
 *   PATCH /admin/documents/:doc_id/status verify/reject an uploaded document
 *   POST /admin/drivers/:id/move          ADMIN: assign driver to a real fleet
 *   POST /admin/drivers/:id/assign-vehicle|assign-trailer   mandatory B2B step
 *   POST /admin/drivers/:id/suspend       body {active?:boolean} to reactivate
 *   POST /admin/drivers/:id/revoke-device lost/stolen phone ⇒ force re-pair
 *   GET  /admin/vehicles | /admin/trailers  asset directories for pickers
 * ------------------------------------------------------------------------- */

export type DriverDocStatus = 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export interface DriverDocumentSummary {
  doc_type: string;
  status: DriverDocStatus;
  expires_on: string | null;
  uploaded_at: string;
}

export interface DriverDocumentRow {
  id: string;
  doc_type: string;
  mime_type: string | null;
  size_bytes: number | null;
  expires_on: string | null;
  status: DriverDocStatus;
  review_note: string | null;
  reviewed_at: string | null;
  uploaded_at: string;
}

export interface ActiveVehicleRef {
  vehicle_id: string;
  plate_number: string;
  body_type: string | null;
  made_by_admin: boolean;
}

export interface AdminDriverRow {
  id: string;
  full_name: string;
  phone_e164: string;
  is_active: boolean;
  created_at: string;
  fleet_id: string;
  fleet_name: string;
  license_number: string | null;
  license_class: string | null;
  license_expiry: string | null;
  association_name: string | null;
  home_base: string | null;
  documents: DriverDocumentSummary[];
  active_vehicle: ActiveVehicleRef | null;
  active_trailers: number;
}

export interface AdminVehicleRow {
  id: string;
  plate_number: string;
  vehicle_type: string | null;
  make_model: string | null;
  capacity_tons: number | null;
  body_type: string | null;
  ownership_status: string | null;
  fleet_id: string;
  fleet_name: string;
  current_driver: { driver_id: string; full_name: string; assigned_at: string; by_admin: boolean } | null;
}

export interface AdminTrailerRow {
  id: string;
  plate_number: string;
  trailer_type: string | null;
  capacity_tons: number | null;
  equipment_details: string | null;
  fleet_id: string | null;
  current_driver: { driver_id: string; full_name: string; assigned_at: string } | null;
}

export interface DriverDossier extends AdminDriverRow {
  locale: string | null;
  ownership_status: string | null;
  documents: DriverDocumentRow[];
  vehicle_history: Array<{ vehicle_id: string; plate_number: string; assigned_at: string; unassigned_at: string | null; created_by_admin: boolean }>;
  trailer_history: Array<{ trailer_id: string; plate_number: string; trailer_type: string | null; assigned_at: string; unassigned_at: string | null; created_by_admin: boolean }>;
  devices: Array<{ id: string; device_id: string; platform: string | null; app_version: string | null; paired_at: string; last_seen_at: string | null; revoked_at: string | null }>;
}

export type DriverQueueStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'ALL';

export const getAdminDrivers = (status: DriverQueueStatus = 'ALL', q?: string) => {
  const qs = new URLSearchParams({ status });
  if (q) qs.set('q', q);
  return api<{ count: number; drivers: AdminDriverRow[] }>(`/admin/drivers?${qs}`);
};

export const getDriverDossier = (driverId: string) =>
  api<DriverDossier>(`/admin/drivers/${encodeURIComponent(driverId)}`);

export const reviewDriverDocument = (docId: string, status: 'VERIFIED' | 'REJECTED', reviewNote?: string) =>
  api<{ id: string; driver_id: string; doc_type: string; status: string }>(
    `/admin/documents/${encodeURIComponent(docId)}/status`,
    { method: 'PATCH', body: JSON.stringify({ status, review_note: reviewNote }) },
  );

export const moveDriverToFleet = (driverId: string, fleetId: string) =>
  api<{ id: string; full_name: string; fleet_id: string }>(
    `/admin/drivers/${encodeURIComponent(driverId)}/move`,
    { method: 'POST', body: JSON.stringify({ fleet_id: fleetId }) },
  );

export const adminAssignVehicle = (driverId: string, vehicleId: string) =>
  api<{ driver_id: string; vehicle_id: string; plate_number: string; assigned: boolean }>(
    `/admin/drivers/${encodeURIComponent(driverId)}/assign-vehicle`,
    { method: 'POST', body: JSON.stringify({ vehicle_id: vehicleId }) },
  );

export const adminAssignTrailer = (driverId: string, trailerId: string) =>
  api<{ driver_id: string; trailer_id: string; plate_number: string; assigned: boolean }>(
    `/admin/drivers/${encodeURIComponent(driverId)}/assign-trailer`,
    { method: 'POST', body: JSON.stringify({ trailer_id: trailerId }) },
  );

/** active=false suspends (revokes pairings); active=true reactivates and
 *  restores the CURRENT device pairing so the driver keeps using the app. */
export const setDriverActive = (driverId: string, active: boolean) =>
  api<{ id: string; full_name: string; is_active: boolean }>(
    `/admin/drivers/${encodeURIComponent(driverId)}/suspend`,
    { method: 'POST', body: JSON.stringify({ active }) },
  );

export const revokeDriverDevice = (driverId: string, deviceId: string, reason?: string) =>
  api<{ revoked: boolean }>(
    `/admin/drivers/${encodeURIComponent(driverId)}/revoke-device`,
    { method: 'POST', body: JSON.stringify({ device_id: deviceId, reason }) },
  );

export const getAdminVehicles = () =>
  api<{ count: number; vehicles: AdminVehicleRow[] }>('/admin/vehicles');

export const getAdminTrailers = () =>
  api<{ count: number; trailers: AdminTrailerRow[] }>('/admin/trailers');

/** Fleet directory (for the "move to fleet" picker). Mirrors GET /fleets. */
export interface FleetRow { id: string; name: string; status: string }
export const getFleets = () => api<{ count: number; fleets: FleetRow[] }>('/fleets');
