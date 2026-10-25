import { describe, it, expect } from 'vitest';

// These suites exercise PURE helpers only (zero I/O). However,
// src/modules/geofence/service.js transitively imports db/pool.js → config/env.js,
// which fail-fasts with process.exit(1) when required secrets are absent. Set the
// documented inert test contract BEFORE importing so env validation passes without
// any live database connection being made (pool connects lazily on first query).
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://yet:test@localhost:5432/yet_test';
process.env.JWT_SECRET ??= 'osm-gateway-test-secret-0123456789abcdef';

const {
  roundCoord, parseLatLng, routeCacheKey, geocodeCacheKey, decodePolyline,
  computeEta, validateCircle, validateRing, ringToMultipolygonJson,
} = await import('../src/modules/osm_gateway/geo.js');
const { normalizeGeofence, GeofenceValidationError } = await import(
  '../src/modules/geofence/service.js'
);
const { pointInRing, parseWktPoint } = await import('../src/modules/geofence/crossing.js');

/**
 * Phase 3 gate tests — OSM Gateway + Geofence PURE helpers (§1.5 Module 7 / 4).
 * Same discipline as Phase 2's trip_state_machine.test.ts: zero I/O, runnable
 * without Postgres/Redis/OSRM/Nominatim containers.
 */

/* ------------------------- coordinate normalization ------------------------ */

describe('coordinate normalization (cache-key stability)', () => {
  it('rounds to 6 decimals (~11 cm) — below GPS noise, above float drift', () => {
    expect(roundCoord(9.0350123456)).toBeCloseTo(9.035012, 6);
    expect(roundCoord(-38.74)).toBe(-38.74);
  });

  it('parseLatLng accepts "lat,lng" with whitespace, rejects garbage', () => {
    expect(parseLatLng('9.03, 38.74')).toEqual({ lat: 9.03, lng: 38.74 });
    expect(() => parseLatLng('9.03')).toThrow();
    expect(() => parseLatLng('91,38')).toThrow(/out-of-range/);
    expect(() => parseLatLng('abc,def')).toThrow(/non-numeric/);
  });

  it('routeCacheKey is stable across equivalent textual inputs', () => {
    const a = routeCacheKey(parseLatLng('9.0350,38.740'), parseLatLng('8.98,38.79'));
    const b = routeCacheKey(parseLatLng('9.035,38.7400000'), parseLatLng('8.9800,38.79'));
    expect(a).toBe(b);
    expect(a).toContain('|'); // from|to separation
    // Direction matters: A→B ≠ B→A (asymmetric routes on one-way networks).
    expect(routeCacheKey(parseLatLng('9.0,38.7'), parseLatLng('8.9,38.8')))
      .not.toBe(routeCacheKey(parseLatLng('8.9,38.8'), parseLatLng('9.0,38.7')));
  });

  it('geocodeCacheKey normalizes case/whitespace but keeps language separate', () => {
    expect(geocodeCacheKey('  Bole  Airport ')).toBe(geocodeCacheKey('bole airport'));
    expect(geocodeCacheKey('Bole', 'am')).not.toBe(geocodeCacheKey('Bole', 'en'));
  });
});

/* ------------------------------ polyline decode ---------------------------- */

describe('decodePolyline (OSRM geometry → [lat,lng][] vectors)', () => {
  it('decodes the canonical Google example', () => {
    // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" = (38.5,-120.2),(40.7,-120.95),(43.252,-126.453)
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toHaveLength(3);
    expect(pts[0]![0]).toBeCloseTo(38.5, 5);
    expect(pts[0]![1]).toBeCloseTo(-120.2, 5);
    expect(pts[1]![0]).toBeCloseTo(40.7, 5);
    expect(pts[2]![0]).toBeCloseTo(43.252, 5);
    expect(pts[2]![1]).toBeCloseTo(-126.453, 5);
  });

  it('handles negative deltas and Addis-scale coordinates', () => {
    // Encode/decode round-trip at OSRM's precision 5.
    const expected: [number, number][] = [[9.035, 38.74], [8.98, 38.79]];
    const back = decodePolyline(encodePolyline(expected, 5));
    expect(back).toHaveLength(2);
    expect(back[0]![0]).toBeCloseTo(9.035, 5);
    expect(back[0]![1]).toBeCloseTo(38.74, 5);
    expect(back[1]![0]).toBeCloseTo(8.98, 5);
    expect(back[1]![1]).toBeCloseTo(38.79, 5);
  });

  it('throws on truncated input instead of returning partial geometry', () => {
    expect(() => decodePolyline('_p~iF~ps|U_')).toThrow(/truncated/);
  });

  it('empty string decodes to empty vector', () => {
    expect(decodePolyline('')).toEqual([]);
  });
});

/** Local encoder for round-trip tests (mirrors Google's reference algorithm). */
function encodePolyline(points: [number, number][], precision = 5): string {
  const factor = 10 ** precision;
  let res = '';
  let pLat = 0, pLng = 0;
  for (const [lat, lng] of points) {
    const la = Math.round(lat * factor), ln = Math.round(lng * factor);
    res += encodeValue(la - pLat); pLat = la;
    res += encodeValue(ln - pLng); pLng = ln;
  }
  return res;
}
function encodeValue(v: number): string {
  let n = v << 1;
  if (v < 0) n = ~n;
  let s = '';
  while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
  return s + String.fromCharCode(n + 63);
}

/* ---------------------------------- ETA ------------------------------------ */

describe('computeEta (speed-blend + stopped/stale rules)', () => {
  const NOW = Date.parse('2026-10-23T10:00:00Z');

  it('fast vehicle at/above OSRM implied speed trusts the route model', () => {
    // 10 km in 1000 s ⇒ implied 10 m/s; vehicle doing 14 m/s ⇒ method osrm.
    const r = computeEta({ osrmDurationS: 1000, distanceM: 10_000, vehicleSpeedMps: 14, stoppedSinceMs: null }, NOW);
    expect(r.eta_method).toBe('osrm');
    expect(r.eta_seconds).toBe(1000);
    expect(r.stale).toBe(false);
  });

  it('slow vehicle ⇒ distance/currentSpeed adjustment dominates', () => {
    // Implied OSRM 10 m/s; reality 5 m/s ⇒ 10_000/5 = 2000 s.
    const r = computeEta({ osrmDurationS: 1000, distanceM: 10_000, vehicleSpeedMps: 5, stoppedSinceMs: null }, NOW);
    expect(r.eta_method).toBe('speed_adjusted');
    expect(r.eta_seconds).toBe(2000);
    expect(r.stale).toBe(false);
  });

  it('no speed signal ⇒ conservative urban fallback, never absurd', () => {
    const r = computeEta({ osrmDurationS: 1000, distanceM: 10_000, vehicleSpeedMps: null, stoppedSinceMs: null }, NOW);
    expect(r.eta_method).toBe('fallback_avg_speed');
    // max(1000, 10000/8.33≈1200) = 1200
    expect(r.eta_seconds).toBe(1200);
  });

  it('STOPPED vehicle ⇒ numeric ETA kept but marked stale with last-movement timestamp (§Phase 3 caveat)', () => {
    const stopAt = NOW - 15 * 60_000;
    const r = computeEta({ osrmDurationS: 900, distanceM: 6000, vehicleSpeedMps: 0, stoppedSinceMs: stopAt }, NOW);
    expect(r.stale).toBe(true);
    expect(r.last_movement_at).toBe(new Date(stopAt).toISOString());
    expect(r.eta_seconds).toBe(900); // extrapolating distance/ε would be absurd; keep OSRM
  });

  it('moving vehicle reports last_movement_at = now (fresh)', () => {
    const r = computeEta({ osrmDurationS: 900, distanceM: 6000, vehicleSpeedMps: 12, stoppedSinceMs: null }, NOW);
    expect(r.stale).toBe(false);
    expect(r.last_movement_at).toBe(new Date(NOW).toISOString());
  });
});

/* -------------------------- geofence ring validators ------------------------ */

describe('validateCircle / validateRing', () => {
  it('accepts a sane warehouse circle', () => {
    expect(validateCircle({ kind: 'CIRCLE', center: { lat: 9.03, lng: 38.74 }, radius_m: 250 })).toBeNull();
  });
  it('rejects bad radius / out-of-range centers', () => {
    expect(validateCircle({ kind: 'CIRCLE', center: { lat: 9.03, lng: 38.74 }, radius_m: 0 })).toMatch(/radius/);
    expect(validateCircle({ kind: 'CIRCLE', center: { lat: 9.03, lng: 38.74 }, radius_m: 200_000 })).toMatch(/radius/);
    expect(validateCircle({ kind: 'CIRCLE', center: { lat: 95, lng: 38.74 }, radius_m: 10 })).toMatch(/lat/);
  });

  const square: [number, number][] = [
    [9.03, 38.74], [9.03, 38.75], [9.04, 38.75], [9.04, 38.74], [9.03, 38.74],
  ];
  it('accepts a closed non-degenerate ring', () => {
    expect(validateRing(square)).toBeNull();
  });
  it('rejects open rings, <4 points, and zero-area (collinear) rings', () => {
    expect(validateRing(square.slice(0, 4))).toMatch(/at least 4|closed/);
    expect(validateRing([square[0]!, square[1]!, square[2]!])).toMatch(/at least 4/);
    const open = [[9.03, 38.74], [9.03, 38.75], [9.04, 38.75], [9.041, 38.74]] as [number, number][];
    expect(validateRing(open)).toMatch(/not closed/);
    const line = [[9, 38], [9, 38.001], [9, 38.002], [9, 38]] as [number, number][];
    expect(validateRing(line)).toMatch(/zero area|degenerate/);
  });

  it('ringToMultipolygonJson emits GeoJSON [lng,lat] order', () => {
    const gj = JSON.parse(ringToMultipolygonJson(square));
    expect(gj.type).toBe('MultiPolygon');
    expect(gj.coordinates[0][0][0]).toEqual([38.74, 9.03]); // lng first!
  });
});

/* --------------------------- normalizeGeofence (API body) ------------------- */

describe('normalizeGeofence validation surface', () => {
  it('passes valid circles through with defaults', () => {
    const g = normalizeGeofence({ kind: 'CIRCLE', name: 'Akaki Warehouse', center: { lat: 9.0, lng: 38.7 }, radius_m: 300 });
    expect(g.kind).toBe('CIRCLE');
    if (g.kind === 'CIRCLE') expect(g.center).toEqual({ lat: 9.0, lng: 38.7 });
    expect((g as any).category).toBe('OTHER');
  });
  it('throws GeofenceValidationError (statusCode 400) on invalid bodies', () => {
    expect(() => normalizeGeofence({ kind: 'CIRCLE', name: '', center: { lat: 9, lng: 38 }, radius_m: 10 }))
      .toThrow(GeofenceValidationError);
    expect(() => normalizeGeofence({ kind: 'HEXAGON', name: 'x' })).toThrow(/CIRCLE.*POLYGON|kind/);
    try { normalizeGeofence({ kind: 'CIRCLE', name: 'x', center: { lat: 200, lng: 0 }, radius_m: 5 }); }
    catch (e: any) { expect(e.statusCode).toBe(400); }
  });
});

/* --------------------- crossing evaluator pure geometry bits ---------------- */

describe('crossing helper geometry (JS mirror of PostGIS path)', () => {
  const squareRing: [number, number][] = [
    [38.74, 9.03], [38.75, 9.03], [38.75, 9.04], [38.74, 9.04], [38.74, 9.03],
  ]; // [lng,lat] as stored by ST_AsText parsing
  it('pointInRing classifies inside/outside/on-the-east correctly', () => {
    expect(pointInRing(9.035, 38.745, squareRing)).toBe(true);   // inside
    expect(pointInRing(9.035, 38.76, squareRing)).toBe(false);   // east outside
    expect(pointInRing(9.05, 38.745, squareRing)).toBe(false);   // north outside
  });
  it('parseWktPoint reads ST_AsText POINT output', () => {
    expect(parseWktPoint('POINT(38.74 9.03)')).toEqual({ lng: 38.74, lat: 9.03 });
    expect(parseWktPoint('MULTIPOINT((1 2))')).toBeNull();
  });
});
