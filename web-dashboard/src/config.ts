/**
 * YET dashboard config. Tiles MUST come from the self-hosted server in production
 * (§1.9.3: public OSM tile servers are forbidden for YET's usage profile).
 * In dev, vite proxies /tiles -> localhost:8082 (tileserver-gl container).
 */
export const TILE_URL = import.meta.env.VITE_TILE_URL ?? '/tiles/{z}/{x}/{y}.png';
export const ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (YET self-hosted tiles)';

// Addis Ababa — Phase 0 map center per blueprint.
export const ADDIS_ABABA: [number, number] = [9.035, 38.74];
export const DEFAULT_ZOOM = 11;

export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';
