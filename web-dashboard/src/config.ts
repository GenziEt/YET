/**
 * YET dashboard config. Tiles MUST come from the self-hosted server in production
 * (§1.9.3: public OSM tile servers are forbidden for YET's usage profile).
 * In dev, vite proxies /tiles -> localhost:8082 (tileserver-gl container).
 */
export const TILE_URL = import.meta.env.VITE_TILE_URL ?? '/tiles/{z}/{x}/{y}.png';
/** §1.9.3 offline posture: marker icons vendored from leaflet@1.9.4 into public/leaflet-images/. */
export const MARKER_ICON_URL = '/leaflet-images/marker-icon.png';
export const MARKER_ICON_2X_URL = '/leaflet-images/marker-icon-2x.png';
export const MARKER_SHADOW_URL = '/leaflet-images/marker-shadow.png';

export const ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (YET self-hosted tiles)';

// Addis Ababa — Phase 0 map center per blueprint.
export const ADDIS_ABABA: [number, number] = [9.035, 38.74];
export const DEFAULT_ZOOM = 11;

export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';
