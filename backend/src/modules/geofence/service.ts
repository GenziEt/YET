/**
 * Module 4 — Geofence & Route: CRUD service (Phase 3).
 * Owns: geofences, route_cache (§1.5). Geometry lives in PostGIS; the API speaks
 * plain lat/lng JSON so the Leaflet drawing tool never has to build GeoJSON by hand.
 */

import { pool } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import {
  validateCircle, validateRing, ringToMultipolygonJson,
  type GeofenceCircle, type GeofencePolygon,
} from '../osm_gateway/geo.js';

export type GeofenceInput =
  | ({ kind: 'CIRCLE' } & GeofenceCircle & { name: string; category?: string })
  | ({ kind: 'POLYGON' } & GeofencePolygon & { name: string; category?: string });

export class GeofenceValidationError extends Error {
  statusCode = 400;
  constructor(public detail: string) { super(detail); }
}

const CATEGORIES = ['WAREHOUSE', 'CUSTOMER_SITE', 'RESTRICTED_ZONE', 'DEPOT', 'OTHER'] as const;

function rowToDto(r: any) {
  return {
    geofence_id: r.geofence_id,
    name: r.name,
    kind: r.kind,
    category: r.category,
    active: r.active,
    center: r.center_lat != null ? { lat: Number(r.center_lat), lng: Number(r.center_lng) } : null,
    radius_m: r.radius_m != null ? Number(r.radius_m) : null,
    ring: r.ring_json ?? null, // [[lat,lng],...] closed — dashboard redraws directly
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

/** Validate + normalize an incoming geofence body. Pure of DB — unit-testable. */
export function normalizeGeofence(body: unknown): GeofenceInput {
  const b = body as any;
  if (!b || typeof b !== 'object') throw new GeofenceValidationError('body must be an object');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > 200) throw new GeofenceValidationError('name required (1..200 chars)');
  const category = (CATEGORIES as readonly string[]).includes(b.category) ? b.category : 'OTHER';

  if (b.kind === 'CIRCLE') {
    const circle: GeofenceCircle = {
      kind: 'CIRCLE',
      center: { lat: Number(b.center?.lat), lng: Number(b.center?.lng) },
      radius_m: Number(b.radius_m),
    };
    const err = validateCircle(circle);
    if (err) throw new GeofenceValidationError(err);
    return { ...circle, name, category };
  }
  if (b.kind === 'POLYGON') {
    const ring = (Array.isArray(b.ring) ? b.ring : []).map(
      (p: any) => [Number(p[0]), Number(p[1])] as [number, number]);
    const poly: GeofencePolygon = { kind: 'POLYGON', ring };
    const err = validateRing(ring);
    if (err) throw new GeofenceValidationError(err);
    return { ...poly, name, category };
  }
  throw new GeofenceValidationError("kind must be 'CIRCLE' or 'POLYGON'");
}

export async function createGeofence(actorId: string, body: unknown) {
  const dto = normalizeGeofence(body);
  if (dto.kind === 'CIRCLE') {
    // geom built server-side from center_lat/center_lng — the API never accepts raw WKT.
    const { rows } = await pool.query(
      `INSERT INTO geofences (name, kind, category, radius_m, center_lat, center_lng, geom, created_by)
       VALUES ($1,$2,$3::geofence_category,$4,$5,$6,
               ST_SetSRID(ST_MakePoint($6,$5), 4326), $7)
       RETURNING *`,
      [dto.name, dto.kind, dto.category, dto.radius_m, dto.center.lat, dto.center.lng, actorId],
    );
    await audit({ actorId, action: 'geofence_create', detail: { geofence_id: rows[0].geofence_id, name: dto.name } });
    return rowToDto(rows[0]);
  }
  // POLYGON
  const gj = ringToMultipolygonJson(dto.ring);
  // centroid for convenience display
  const { rows: cen } = await pool.query(
    `SELECT ST_Y(c) AS lat, ST_X(c) AS lng FROM
       (SELECT ST_Centroid(ST_GeomFromGeoJSON($1)::geometry) c) s`, [gj]);
  const { rows } = await pool.query(
    `INSERT INTO geofences (name, kind, category, geom, ring_json, center_lat, center_lng, created_by)
     VALUES ($1,'POLYGON',$2::geofence_category,
             ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $3::jsonb, $4, $5, $6)
     RETURNING *`,
    [dto.name, dto.category, gj, Number(cen[0]?.lat ?? 0), Number(cen[0]?.lng ?? 0), actorId],
  );
  await audit({ actorId, action: 'geofence_create', detail: { geofence_id: rows[0].geofence_id, name: dto.name } });
  return rowToDto(rows[0]);
}

export async function updateGeofence(actorId: string, geofenceId: string, body: unknown) {
  const existing = await getGeofence(geofenceId);
  if (!existing) throw Object.assign(new Error('geofence_not_found'), { statusCode: 404 });
  // Merge: allow partial updates (rename/toggle) without resending geometry.
  const merged = { ...existingToBody(existing), ...(body as object) };
  const dto = normalizeGeofence(merged);
  if (dto.kind === 'CIRCLE') {
    const { rows } = await pool.query(
      `UPDATE geofences SET name=$2, kind='CIRCLE', category=$3::geofence_category,
              radius_m=$4, center_lat=$5, center_lng=$6,
              geom=ST_SetSRID(ST_MakePoint($6,$5),4326), ring_json=NULL,
              active=COALESCE($7, active), updated_at=now()
        WHERE geofence_id=$1 RETURNING *`,
      [geofenceId, dto.name, dto.category, dto.radius_m, dto.center.lat, dto.center.lng,
       (body as any)?.active ?? null],
    );
    await audit({ actorId, action: 'geofence_update', detail: { geofence_id: geofenceId } });
    return rowToDto(rows[0]);
  }
  const gj = ringToMultipolygonJson(dto.ring);
  const { rows: cen } = await pool.query(
    `SELECT ST_Y(c) AS lat, ST_X(c) AS lng FROM
       (SELECT ST_Centroid(ST_GeomFromGeoJSON($1)::geometry) c) s`, [gj]);
  const { rows } = await pool.query(
    `UPDATE geofences SET name=$2, kind='POLYGON', category=$3::geofence_category,
            radius_m=NULL, geom=ST_SetSRID(ST_GeomFromGeoJSON($4),4326), ring_json=$4::jsonb,
            center_lat=$5, center_lng=$6, active=COALESCE($7, active), updated_at=now()
      WHERE geofence_id=$1 RETURNING *`,
    [geofenceId, dto.name, dto.category, gj, Number(cen[0]?.lat ?? 0), Number(cen[0]?.lng ?? 0),
     (body as any)?.active ?? null],
  );
  await audit({ actorId, action: 'geofence_update', detail: { geofence_id: geofenceId } });
  return rowToDto(rows[0]);
}

function existingToBody(g: ReturnType<typeof rowToDto>) {
  return g.kind === 'CIRCLE'
    ? { kind: 'CIRCLE', name: g.name, category: g.category, center: g.center, radius_m: g.radius_m }
    : { kind: 'POLYGON', name: g.name, category: g.category, ring: g.ring };
}

export async function deleteGeofence(actorId: string, geofenceId: string) {
  // Soft-delete: deactivate rather than drop — trip_events payloads keep referencing
  // geofence ids and fleet history must remain interpretable (§1.7 retention posture).
  const { rows } = await pool.query(
    `UPDATE geofences SET active=FALSE, updated_at=now()
      WHERE geofence_id=$1 AND active=TRUE RETURNING geofence_id`, [geofenceId]);
  if (rows.length === 0) return false;
  await audit({ actorId, action: 'geofence_deactivate', detail: { geofence_id: geofenceId } });
  return true;
}

export async function getGeofence(geofenceId: string) {
  const { rows } = await pool.query(`SELECT * FROM geofences WHERE geofence_id=$1`, [geofenceId]);
  return rows[0] ? rowToDto(rows[0]) : null;
}

export async function listGeofences(opts: { active_only?: boolean } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM geofences ${opts.active_only === false ? '' : 'WHERE active'} ORDER BY name ASC`);
  return rows.map(rowToDto);
}

/**
 * Inside/outside state of a vehicle's LATEST fix against every active geofence —
 * powers the dashboard layer coloring ("vehicle is inside zone X"). One SQL call,
 * GiST-bounded candidates only.
 */
export async function vehicleGeofenceState(vehicleId: string) {
  const { rows: fixRows } = await pool.query(
    `SELECT lat, lng, fix_timestamp FROM location_fixes
      WHERE vehicle_id=$1 ORDER BY fix_timestamp DESC LIMIT 1`, [vehicleId]);
  const last = fixRows[0];
  if (!last) return { vehicle_id: vehicleId, last_fix_at: null, inside: [], states: [] };
  const { rows } = await pool.query(
    `SELECT g.geofence_id, g.name, g.category, g.kind,
            CASE WHEN g.kind='CIRCLE'
                 THEN ST_DWithin(g.geom::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, g.radius_m)
                 ELSE ST_Intersects(g.geom, ST_SetSRID(ST_MakePoint($2,$1),4326)) END AS inside
       FROM geofences g
      WHERE g.active
        AND ST_DWithin(g.geom::geography, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, 20000)
      ORDER BY g.name`,
    [Number(last.lat), Number(last.lng)]);
  return {
    vehicle_id: vehicleId,
    last_fix_at: new Date(last.fix_timestamp).toISOString(),
    inside: rows.filter((r) => r.inside).map((r) => ({ geofence_id: r.geofence_id, name: r.name, category: r.category })),
    states: rows.map((r) => ({ geofence_id: r.geofence_id, name: r.name, kind: r.kind, inside: r.inside })),
  };
}
