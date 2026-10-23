import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import type { GeofenceCategory, GeofenceDto } from '../lib/api';

/**
 * Phase 3 — Leaflet circle/polygon drawing editor (blueprint: "Geofence drawing
 * tool on Leaflet map"). Implemented directly against the Leaflet API inside the
 * existing MapContainer (no leaflet-draw dependency — §1.9 bundle discipline for
 * low-end devices and a 3G time-to-interactive budget).
 *
 * Modes:
 *   CIRCLE  : click center → drag/click to set radius → preview → Save (POST /geofences)
 *   POLYGON : click vertices → click first vertex (or double-click) to close → Save
 * Editing an existing geofence reuses the same surface with pre-populated geometry
 * and PUT semantics. The parent owns the actual API call via onSave so this
 * component stays presentational + testable.
 */

export interface DraftGeometry {
  kind: 'CIRCLE' | 'POLYGON';
  center?: { lat: number; lng: number };
  radius_m?: number;
  ring?: [number, number][]; // closed [lat,lng][] — backend contract
}

export interface EditorSavePayload extends DraftGeometry {
  name: string;
  category: GeofenceCategory;
}

interface Props {
  /** Existing geofence to edit, or null for "create new". */
  editing: GeofenceDto | null;
  onSave: (payload: EditorSavePayload) => Promise<void>;
  onCancel: () => void;
  /** True while a save is in flight — disables buttons, avoids double POSTs. */
  busy?: boolean;
}

const RING_CLOSE_MAX_POINTS = 500; // matches backend zod max

export default function GeofenceEditor({ editing, onSave, onCancel, busy }: Props) {
  const map = useMap();
  const layerRef = useRef<L.LayerGroup | null>(null);
  const [kind, setKind] = useState<'CIRCLE' | 'POLYGON'>(editing?.kind ?? 'CIRCLE');
  const [name, setName] = useState(editing?.name ?? '');
  const [category, setCategory] = useState<GeofenceCategory>(editing?.category ?? 'WAREHOUSE');
  const [center, setCenter] = useState<[number, number] | null>(
    editing?.kind === 'CIRCLE' && editing.center ? [editing.center.lat, editing.center.lng] : null);
  const [radiusM, setRadiusM] = useState<number>(editing?.radius_m ?? 300);
  const [vertices, setVertices] = useState<[number, number][]>([]);
  const [error, setError] = useState<string | null>(null);

  // Live preview layer (circle/ring outline + vertex dots) redrawn on each change.
  useEffect(() => {
    if (!layerRef.current) {
      layerRef.current = L.layerGroup().addTo(map);
    }
    const group = layerRef.current;
    group.clearLayers();
    if (kind === 'CIRCLE' && center) {
      L.circle(center, { radius: radiusM, color: '#7c3aed', weight: 2, dashArray: '6 4', fillOpacity: 0.08 }).addTo(group);
      L.circleMarker(center, { radius: 4, color: '#7c3aed' }).addTo(group);
    } else if (kind === 'POLYGON' && vertices.length > 0) {
      const closed = isClosed(vertices);
      L.polyline(closed ? vertices : [...vertices], { color: '#7c3aed', weight: 2, dashArray: '6 4' }).addTo(group);
      vertices.forEach((v, i) =>
        L.circleMarker(v, { radius: i === 0 ? 6 : 4, color: i === 0 ? '#16a34a' : '#7c3aed' }).addTo(group));
    }
    return () => { /* keep layer across renders; cleared above */ };
  }, [map, kind, center, radiusM, vertices]);

  // Cleanup the overlay when the editor unmounts.
  useEffect(() => () => {
    if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null; }
  }, [map]);

  // Click-to-place handler bound to the map while editing.
  useEffect(() => {
    const onClick = (e: L.LeafletMouseEvent) => {
      setError(null);
      if (kind === 'CIRCLE') {
        if (!center) setCenter([e.latlng.lat, e.latlng.lng]);
        else {
          // Second click sets the radius (distance from center), then done.
          const d = map.getPixelOrigin() ? e.latlng.distanceTo(L.latLng(center[0], center[1])) : 0;
          setRadiusM(Math.max(20, Math.round(d)));
        }
      } else {
        const p: [number, number] = [e.latlng.lat, e.latlng.lng];
        if (vertices.length >= 3 && dist(vertices[0]!, p) < 15) {
          // Clicked near first vertex → close the ring (append copy of first point).
          setVertices((v) => closeRing(v));
        } else if (vertices.length < RING_CLOSE_MAX_POINTS) {
          setVertices((v) => [...v, p]);
        }
      }
    };
    const dbl = () => { if (kind === 'POLYGON' && vertices.length >= 3) setVertices((v) => closeRing(v)); };
    map.on('click', onClick);
    map.on('dblclick', dbl);
    return () => { map.off('click', onClick); map.off('dblclick', dbl); };
  }, [map, kind, center, vertices]);

  const draftReady = useMemo(() => {
    if (!name.trim()) return false;
    if (kind === 'CIRCLE') return !!center && radiusM > 0;
    return isClosed(vertices);
  }, [name, kind, center, radiusM, vertices]);

  async function submit() {
    setError(null);
    try {
      if (kind === 'CIRCLE') {
        if (!center) throw new Error('click the map to place the circle center');
        await onSave({ kind: 'CIRCLE', name: name.trim(), category, center: { lat: center[0], lng: center[1] }, radius_m: radiusM });
      } else {
        if (!isClosed(vertices)) throw new Error('close the polygon (click the green first vertex)');
        await onSave({ kind: 'POLYGON', name: name.trim(), category, ring: vertices });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="gf-editor" onClick={(e) => e.stopPropagation()}>
      <div className="gf-editor-row">
        <button className={kind === 'CIRCLE' ? 'active' : ''} disabled={!!editing}
                onClick={() => { setKind('CIRCLE'); setVertices([]); }}>Circle</button>
        <button className={kind === 'POLYGON' ? 'active' : ''} disabled={!!editing}
                onClick={() => { setKind('POLYGON'); setCenter(null); }}>Polygon</button>
        <input value={name} placeholder="Name (e.g. Bole warehouse)" onChange={(e) => setName(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value as GeofenceCategory)}>
          <option value="WAREHOUSE">Warehouse</option>
          <option value="CUSTOMER_SITE">Customer site</option>
          <option value="RESTRICTED_ZONE">Restricted zone</option>
          <option value="DEPOT">Depot</option>
          <option value="OTHER">Other</option>
        </select>
      </div>
      <div className="gf-editor-hint">
        {kind === 'CIRCLE'
          ? (center ? `Click again to set radius (now ${Math.round(radiusM)} m)` : 'Click the map to place the center')
          : (isClosed(vertices) ? 'Ring closed — ready to save'
             : `${vertices.length} vertex/vertices · click the green first vertex (or double-click) to close`)}
      </div>
      {kind === 'CIRCLE' && (
        <label className="gf-editor-row">
          Radius (m)
          <input type="number" min={20} max={100000} value={Math.round(radiusM)}
                 onChange={(e) => setRadiusM(Number(e.target.value) || 0)} />
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <div className="gf-editor-row">
        <button className="primary" disabled={!draftReady || busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : editing ? 'Update geofence' : 'Save geofence'}
        </button>
        <button onClick={onCancel}>Cancel</button>
        {kind === 'POLYGON' && vertices.length > 0 && (
          <button onClick={() => setVertices(isClosed(vertices) ? [] : vertices.slice(0, -1))}>
            {isClosed(vertices) ? 'Clear' : 'Undo vertex'}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ helpers ---------------------------------- */
function dist(a: [number, number], b: [number, number]): number {
  // Approximate meters between two nearby Addis-scale points (cheap, no deps).
  const dLat = (a[0] - b[0]) * 111_320;
  const dLng = (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}
function isClosed(ring: [number, number][]): boolean {
  if (ring.length < 4) return false;
  const f = ring[0]!, l = ring[ring.length - 1]!;
  return f[0] === l[0] && f[1] === l[1];
}
function closeRing(ring: [number, number][]): [number, number][] {
  if (ring.length < 3 || isClosed(ring)) return ring;
  return [...ring, ring[0]!];
}
