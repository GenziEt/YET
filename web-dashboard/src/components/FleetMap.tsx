import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { TILE_URL, ATTRIBUTION, ADDIS_ABABA, DEFAULT_ZOOM } from '../config';

const truckIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34],
});

/**
 * Phase 0: static map centered on Addis Ababa with self-hosted tiles.
 * Phase 1 adds fix polylines; Phase 2 colors by trip state; Phase 5 fleet overview.
 * NOTE (§1.4): a vehicle whose driver has left must render as "last known location"
 * with timestamp — never a live indicator. That rule binds future markers added here.
 */
export default function FleetMap() {
  return (
    <MapContainer
      center={ADDIS_ABABA}
      zoom={DEFAULT_ZOOM}
      style={{ height: '100%', width: '100%' }}
      attributionControl
    >
      <TileLayer url={TILE_URL} attribution={ATTRIBUTION} maxZoom={19} />
      {/* Placeholder marker so the gate reviewer sees a rendered map layer working. */}
      <Marker position={ADDIS_ABABA} icon={truckIcon}>
        <Popup>Merkato depot — demo marker (no live data until Phase 1)</Popup>
      </Marker>
    </MapContainer>
  );
}
