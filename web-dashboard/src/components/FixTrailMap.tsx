import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup, useMap } from 'react-leaflet';
import { ADDIS_ABABA, DEFAULT_ZOOM, TILE_URL, ATTRIBUTION } from '../config';
import type { LocationFixRow } from '../lib/api';

/** Re-center the map whenever a new trail is loaded (keeps one MapContainer mounted). */
function FitToFixes({ fixes }: { fixes: LocationFixRow[] }) {
  const map = useMap();
  useEffect(() => {
    if (fixes.length === 0) {
      map.setView(ADDIS_ABABA, DEFAULT_ZOOM);
      return;
    }
    const bounds = L_bounds(fixes);
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  }, [fixes, map]);
  return null;
}

function L_bounds(fixes: LocationFixRow[]): [[number, number], [number, number]] {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const f of fixes) {
    if (f.lat < minLat) minLat = f.lat;
    if (f.lat > maxLat) maxLat = f.lat;
    if (f.lng < minLng) minLng = f.lng;
    if (f.lng > maxLng) maxLng = f.lng;
  }
  // Degenerate single-point trail: pad so fitBounds doesn't zoom to max.
  if (minLat === maxLat && minLng === maxLng) {
    return [[minLat - 0.005, minLng - 0.005], [maxLat + 0.005, maxLng + 0.005]];
  }
  return [[minLat, minLng], [maxLat, maxLng]];
}

/**
 * Phase 1 raw-fix history view (§1.5 Module 2 read side; blueprint Phase 1:
 * "Polyline on the map connecting fixes in time order").
 * The backend already returns fixes ordered by EVENT time (§1.8.3), so we draw
 * them as-is — never re-sort by arrival/received_at.
 * Trip-state coloring (green/gray/red) arrives in Phase 2; this stays deliberately dumb.
 */
export default function FixTrailMap({ fixes }: { fixes: LocationFixRow[] }) {
  const path = useMemo<[number, number][]>(
    () => fixes.map((f) => [f.lat, f.lng]),
    [fixes],
  );
  const first = fixes[0];
  const last = fixes[fixes.length - 1];

  return (
    <MapContainer
      center={first ? [first.lat, first.lng] : ADDIS_ABABA}
      zoom={DEFAULT_ZOOM}
      style={{ height: '100%', width: '100%' }}
      attributionControl
    >
      <TileLayer url={TILE_URL} attribution={ATTRIBUTION} maxZoom={19} />
      {path.length >= 2 && (
        <Polyline positions={path} pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.85 }} />
      )}
      {first && (
        <CircleMarker center={[first.lat, first.lng]} radius={7} pathOptions={{ color: '#16a34a' }}>
          <Popup>Trip window start · {new Date(first.fix_timestamp).toLocaleString()}</Popup>
        </CircleMarker>
      )}
      {last && last !== first && (
        <CircleMarker center={[last.lat, last.lng]} radius={7} pathOptions={{ color: '#dc2626' }}>
          <Popup>Latest fix · {new Date(last.fix_timestamp).toLocaleString()}</Popup>
        </CircleMarker>
      )}
      {/* Single-fix case still needs a visible marker. */}
      {fixes.length === 1 && first && (
        <CircleMarker center={[first.lat, first.lng]} radius={7} pathOptions={{ color: '#2563eb' }}>
          <Popup>Only fix · {new Date(first.fix_timestamp).toLocaleString()}</Popup>
        </CircleMarker>
      )}
      <FitToFixes fixes={fixes} />
    </MapContainer>
  );
}
