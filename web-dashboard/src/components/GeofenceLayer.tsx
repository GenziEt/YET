import { Circle, Polygon, Popup, Tooltip } from 'react-leaflet';
import type { GeofenceDto, VehicleGeofenceState } from '../lib/api';

/**
 * Phase 3 — geofence overlay for Leaflet maps (react-leaflet children; mount
 * inside a <MapContainer>). Colors encode the vehicle's inside/outside state
 * from GET /geofences/state (dashboard deliverable: "geofence layer showing
 * vehicle inside/outside state").
 *
 *   inside zone        → green fill
 *   outside (near)     → amber dashed outline
 *   no vehicle context → neutral blue
 * Inactive geofences render gray-dotted (history stays interpretable, §1.7).
 */

const CATEGORY_LABEL: Record<string, string> = {
  WAREHOUSE: 'Warehouse', CUSTOMER_SITE: 'Customer site',
  RESTRICTED_ZONE: 'Restricted zone', DEPOT: 'Depot', OTHER: 'Zone',
};

export interface GeofenceLayerProps {
  geofences: GeofenceDto[];
  /** Optional per-zone inside/outside matrix (from /geofences/state). */
  state?: VehicleGeofenceState | null;
  /** Show editor vertices of the geofence currently being drawn/edited. */
  highlightId?: string | null;
}

export default function GeofenceLayer({ geofences, state, highlightId }: GeofenceLayerProps) {
  const insideSet = new Set((state?.states ?? []).filter((s) => s.inside).map((s) => s.geofence_id));
  return (
    <>
      {geofences.map((g) => {
        const inside = insideSet.has(g.geofence_id);
        const color = !g.active ? '#6b7280' : state ? (inside ? '#16a34a' : '#d97706') : '#2563eb';
        const dash = g.active ? undefined : '4 4';
        const weight = highlightId === g.geofence_id ? 4 : 2;
        const popup = (
          <Popup>
            <div className="gf-popup">
              <strong>{g.name}</strong>
              <div>{CATEGORY_LABEL[g.category] ?? g.category} · {g.kind}</div>
              {g.kind === 'CIRCLE' && g.center && g.radius_m != null && (
                <div>r = {(g.radius_m / 1000).toFixed(2)} km @ ({g.center.lat.toFixed(5)}, {g.center.lng.toFixed(5)})</div>
              )}
              {state && (
                <div className={inside ? 'gf-inside' : 'gf-outside'}>
                  vehicle {inside ? 'INSIDE' : 'outside'}
                  {state.last_fix_at ? ` (fix ${new Date(state.last_fix_at).toLocaleTimeString()})` : ''}
                </div>
              )}
              {!g.active && <div className="muted">inactive — kept for history</div>}
            </div>
          </Popup>
        );
        return g.kind === 'CIRCLE' && g.center && g.radius_m != null ? (
          <Circle
            key={g.geofence_id}
            center={[g.center.lat, g.center.lng]}
            radius={g.radius_m}
            pathOptions={{ color, weight, dashArray: dash, fillColor: color, fillOpacity: inside ? 0.25 : 0.08 }}
          >
            <Tooltip permanent={highlightId === g.geofence_id} direction="top">{g.name}</Tooltip>
            {popup}
          </Circle>
        ) : g.kind === 'POLYGON' && g.ring && g.ring.length >= 4 ? (
          <Polygon
            key={g.geofence_id}
            positions={g.ring.map(([lat, lng]) => [lat, lng] as [number, number])}
            pathOptions={{ color, weight, dashArray: dash, fillColor: color, fillOpacity: inside ? 0.25 : 0.08 }}
          >
            <Tooltip permanent={highlightId === g.geofence_id} direction="top">{g.name}</Tooltip>
            {popup}
          </Polygon>
        ) : null;
      })}
    </>
  );
}
