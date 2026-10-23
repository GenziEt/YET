import { API_BASE } from '../config';

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
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

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
