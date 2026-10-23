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
