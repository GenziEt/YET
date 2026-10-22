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
