/**
 * Module 7 — OSM Gateway: pure helpers (§1.5). Zero I/O so they are unit-testable
 * without OSRM/Nominatim/Redis running (same discipline as the Trip Engine kernel).
 */

// ---- Coordinate normalization ------------------------------------------------
// Route/geocode cache keys must be stable across equivalent inputs ("9.0350" vs
// "9.035"). 6 decimal places ≈ 11 cm — far below GPS accuracy, above rounding noise.
export function roundCoord(v: number): number { return Math.round(v * 1e6) / 1e6; }

export type LatLng = { lat: number; lng: number };

export function parseLatLng(raw: string): LatLng {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 2) throw new Error(`expected "lat,lng", got "${raw}"`);
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`non-numeric coordinate "${raw}"`);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error(`out-of-range coordinate "${raw}"`);
  return { lat: roundCoord(lat), lng: roundCoord(lng) };
}

export function routeCacheKey(from: LatLng, to: LatLng, profile = 'driving'): string {
  return `yet:route:v1:${profile}:${from.lat},${from.lng}|${to.lat},${to.lng}`;
}

export function geocodeCacheKey(q: string, lang?: string): string {
  const norm = q.trim().toLowerCase().replace(/\s+/g, ' ');
  return `yet:geocode:v1:${lang ?? 'default'}:${norm}`;
}

// ---- Polyline decoding (Google encoded polyline → [lat,lng] pairs) ------------
// OSRM returns geometry as an encoded polyline; the dashboard draws plain arrays.
// Precision 5 is the OSRM default. Pure function, allocation-light (§1.9 budgets).
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw new Error('polyline truncated');
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1 ? ~(result >> 1) : result >> 1);
    shift = 0; result = 0;
    do {
      if (index >= encoded.length) throw new Error('polyline truncated');
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1 ? ~(result >> 1) : result >> 1);
    out.push([lat / factor, lng / factor]);
  }
  return out;
}

// ---- ETA math (§ Phase 3: "ETA based on current vehicle speed and OSRM duration")
export interface EtaInput {
  osrmDurationS: number;        // routing time under free-flow conditions
  distanceM: number;            // route length in meters
  vehicleSpeedMps: number | null; // last fix speed; null = no signal
  stoppedSinceMs: number | null;  // event time when STOPPED state was entered, else null
}

export interface EtaResult {
  eta_seconds: number;
  eta_method: 'osrm' | 'speed_adjusted' | 'fallback_avg_speed';
  stale: boolean;               // § dashboard caveat: STOPPED ⇒ mark ETA stale
  last_movement_at: string | null;
}

const URBAN_AVG_SPEED_MPS = 8.33; // ~30 km/h — conservative Ethiopia urban fallback

/**
 * Blend OSRM's free-flow duration with the vehicle's ACTUAL recent speed:
 *   adjusted = distance / max(currentSpeed, floor)
 * Reported ETA = min(osrm, adjusted) when moving fast (OSRM already optimistic),
 * max-free blend otherwise; concretely we take the LARGER of the two when the
 * vehicle is slower than the implied OSRM speed (traffic/detour reality), and the
 * OSRM value when it is faster (route knowledge beats instantaneous speed noise).
 * A stopped vehicle keeps producing a numeric ETA but flags it stale (§ blueprint:
 * "If the vehicle is in STOPPED state, ETA is marked 'stale'").
 */
export function computeEta(input: EtaInput, nowMs: number): EtaResult {
  const { osrmDurationS, distanceM, vehicleSpeedMps, stoppedSinceMs } = input;
  const impliedOsrmSpeed = osrmDurationS > 0 ? distanceM / osrmDurationS : 0;

  let eta: number;
  let method: EtaResult['eta_method'];
  if (vehicleSpeedMps == null) {
    eta = Math.max(osrmDurationS, distanceM / URBAN_AVG_SPEED_MPS);
    method = 'fallback_avg_speed';
  } else if (vehicleSpeedMps <= 0.2) {
    // Stopped/near-zero speed: extrapolating distance/ε gives absurd ETAs; keep OSRM.
    eta = osrmDurationS;
    method = 'speed_adjusted';
  } else if (vehicleSpeedMps < impliedOsrmSpeed) {
    eta = distanceM / vehicleSpeedMps; // reality slower than route model
    method = 'speed_adjusted';
  } else {
    eta = osrmDurationS;              // at/above model speed — trust the route
    method = 'osrm';
  }

  return {
    eta_seconds: Math.round(eta),
    eta_method: method,
    stale: stoppedSinceMs != null,
    last_movement_at: stoppedSinceMs != null ? new Date(stoppedSinceMs).toISOString() : new Date(nowMs).toISOString(),
  };
}

// ---- Geofence geometry validation ----------------------------------------------
export type GeofenceCircle = { kind: 'CIRCLE'; center: LatLng; radius_m: number };
export type GeofencePolygon = { kind: 'POLYGON'; ring: [number, number][] }; // [lat,lng][], closed

export function validateCircle(c: GeofenceCircle): string | null {
  if (!Number.isFinite(c.center.lat) || Math.abs(c.center.lat) > 90) return 'center.lat out of range';
  if (!Number.isFinite(c.center.lng) || Math.abs(c.center.lng) > 180) return 'center.lng out of range';
  if (!Number.isFinite(c.radius_m) || c.radius_m <= 0 || c.radius_m > 100_000) return 'radius_m must be in (0, 100000]';
  return null;
}

export function validateRing(ring: [number, number][]): string | null {
  if (ring.length < 4) return 'polygon ring needs at least 4 points (closed triangle)';
  for (const [lat, lng] of ring) {
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return 'vertex lat out of range';
    if (!Number.isFinite(lng) || Math.abs(lng) > 180) return 'vertex lng out of range';
  }
  const [first, last] = [ring[0]!, ring[ring.length - 1]!];
  if (first[0] !== last[0] || first[1] !== last[1]) return 'ring not closed (first != last vertex)';
  // Reject self-touching degenerate rings cheaply: require non-zero area via shoelace.
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [y1, x1] = ring[i]!, [y2, x2] = ring[i + 1]!;
    area += x1 * y2 - x2 * y1;
  }
  if (Math.abs(area) < 1e-9) return 'degenerate polygon (zero area)';
  return null;
}

/** GeoJSON MULTIPOLYGON text for PostGIS ST_GeomFromGeoJSON (single exterior ring). */
export function ringToMultipolygonJson(ring: [number, number][]): string {
  const coords = ring.map(([lat, lng]) => [lng, lat]); // GeoJSON is [lng,lat]
  return JSON.stringify({ type: 'MultiPolygon', coordinates: [[coords]] });
}
