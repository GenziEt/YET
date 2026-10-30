import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { TILE_URL, ATTRIBUTION, ADDIS_ABABA, DEFAULT_ZOOM } from '../config';
import {
  getDrivers, listGeofences, createGeofence, updateGeofence, deleteGeofence,
  getVehicleGeofenceState, login, logout, currentRole, hasToken, ApiError,
  type DriverRosterEntry, type GeofenceDto, type RouteResponse, type VehicleGeofenceState,
} from '../lib/api';
import GeofenceLayer from '../components/GeofenceLayer';
import type { EditorSavePayload } from '../components/GeofenceEditor';

// §1.9.2: both Leaflet-dependent panels stay lazy — page shell renders without them.
const GeofenceEditor = lazy(() => import('../components/GeofenceEditor'));
const RoutePanel = lazy(() => import('../components/RoutePanel'));

const truckIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34],
});

/** Fit map bounds to route + geofences when a new route arrives (keeps one container). */
function FitToRoute({ route }: { route: RouteResponse | null }) {
  const map = useMap();
  const prevKey = useRef<string | null>(null);
  useEffect(() => {
    if (!route || route.geometry.length < 2) return;
    const key = `${route.from.lat},${route.from.lng}->${route.to.lat},${route.to.lng}`;
    if (key === prevKey.current) return; // don't yank the viewport on every 60 s poll
    prevKey.current = key;
    const pts = route.geometry.map(([lat, lng]) => [lat, lng] as L.LatLngExpression);
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 15 });
  }, [route, map]);
  return null;
}

const WRITE_ROLES = ['FLEET_MANAGER', 'ADMIN'];

export default function ZonesPage() {
  // ---- auth (Phase 3 write actions need a manager/admin JWT) ----------------
  const [tokened, setTokened] = useState(hasToken());
  const [role, setRole] = useState(currentRole() ?? '');
  const [ident, setIdent] = useState('');
  const [pw, setPw] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  // ---- data ------------------------------------------------------------------
  const [drivers, setDrivers] = useState<DriverRosterEntry[]>([]);
  const [vehicleId, setVehicleId] = useState('');
  const [geofences, setGeofences] = useState<GeofenceDto[]>([]);
  const [gfState, setGfState] = useState<VehicleGeofenceState | null>(null);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  // ---- editor ----------------------------------------------------------------
  const [editing, setEditing] = useState<'new' | GeofenceDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canWrite = WRITE_ROLES.includes(role);

  async function doLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    try {
      const r = await login(ident.trim(), pw);
      setRole(r.role); setTokened(true);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    }
  }
  function doLogout() { logout(); setTokened(false); setRole(''); }

  const reloadGeofences = useCallback(async () => {
    try {
      const r = await listGeofences(canWrite);
      setGeofences(r.geofences.filter((g) => canWrite || g.active));
      setLoadedAt(Date.now());
      setError(null);
    } catch (e) { setError(String(e)); }
  }, [canWrite]);

  useEffect(() => {
    getDrivers().then((r) => {
      setDrivers(r.drivers);
      setVehicleId((cur) => cur || r.drivers.find((d) => d.vehicle_id)?.vehicle_id || '');
    }).catch(() => {});
  }, []);

  useEffect(() => { void reloadGeofences(); }, [reloadGeofences]);

  // Inside/outside state polling — powers layer coloring (§ dashboard deliverable).
  useEffect(() => {
    if (!vehicleId) { setGfState(null); return; }
    let cancelled = false;
    const poll = () => getVehicleGeofenceState(vehicleId)
      .then((s) => !cancelled && setGfState(s))
      .catch(() => { /* keep last state; staleness banner covers outages (§1.8.4) */ });
    poll();
    const t = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [vehicleId]);

  const selectedDriver = useMemo(() => drivers.find((d) => d.vehicle_id === vehicleId) ?? null, [drivers, vehicleId]);

  async function handleSave(payload: EditorSavePayload) {
    setBusy(true);
    try {
      if (editing && typeof editing === 'object') {
        await updateGeofence(editing.geofence_id, payload as any);
      } else {
        await createGeofence(payload);
      }
      setEditing(null);
      await reloadGeofences();
    } finally { setBusy(false); }
  }

  async function handleDelete(g: GeofenceDto) {
    if (!confirm(`Deactivate "${g.name}"? Historical events remain linked.`)) return;
    await deleteGeofence(g.geofence_id);
    await reloadGeofences();
  }

  const staleMin = loadedAt ? Math.floor((Date.now() - loadedAt) / 60_000) : 0;

  return (
    <div className="page">
      <header>
        <h1>Zones &amp; ETA</h1>
        {!tokened ? (
          <form className="login-bar" onSubmit={doLogin}>
            <input aria-label="Email or phone" placeholder="email / +251…" value={ident} onChange={(e) => setIdent(e.target.value)} />
            <input aria-label="Password" placeholder="password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <button type="submit">Sign in</button>
            {authError && <span className="error" role="alert">{authError}</span>}
          </form>
        ) : (
          <>
            <span className="pill ok">signed in · {role}</span>
            {!canWrite && <span className="pill warn">read-only (writes need FLEET_MANAGER/ADMIN)</span>}
            <button className="linkish" onClick={doLogout}>Sign out</button>
          </>
        )}
        {staleMin > 2 && <span className="pill warn">zones last updated {staleMin} min ago</span>}
      </header>

      <div className="toolbar">
        <label>
          Vehicle context
          <select aria-label="Vehicle context" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">— none (no inside/outside coloring) —</option>
            {drivers.filter((d) => d.vehicle_id).map((d) => (
              <option key={d.vehicle_id} value={d.vehicle_id!}>{d.full_name} · {d.plate_number}</option>
            ))}
          </select>
        </label>
        {canWrite && !editing && (
          <button onClick={() => setEditing('new')}>+ Draw geofence</button>
        )}
        {gfState && (
          <span className="zone-chips">
            {gfState.inside.length > 0
              ? gfState.inside.map((z) => <span key={z.geofence_id} className="chip inside">{z.name}</span>)
              : <span className="chip outside">outside all zones</span>}
          </span>
        )}
      </div>
      {error && <div className="error banner" role="alert">GET /geofences failed: {error}</div>}

      <main className="split">
        <section className="map-wrap">
          <MapContainer center={ADDIS_ABABA} zoom={DEFAULT_ZOOM} style={{ height: '100%', width: '100%' }} attributionControl>
            <TileLayer url={TILE_URL} attribution={ATTRIBUTION} maxZoom={19} />
            <GeofenceLayer
              geofences={geofences}
              state={gfState}
              highlightId={editing && typeof editing === 'object' ? editing.geofence_id : null}
            />
            {route && route.geometry.length >= 2 && (
              <>
                <Polyline positions={route.geometry} pathOptions={{ color: '#7c3aed', weight: 5, opacity: 0.8, dashArray: route.fallback ? '8 8' : undefined }} />
                <CircleMarker center={[route.from.lat, route.from.lng]} radius={6} pathOptions={{ color: '#2563eb' }}>
                  <Popup>Vehicle origin · fix at {gfState?.last_fix_at ? new Date(gfState.last_fix_at).toLocaleTimeString() : '—'}</Popup>
                </CircleMarker>
                <Marker position={[route.to.lat, route.to.lng]} icon={truckIcon}>
                  <Popup>Destination centroid{route.fallback ? ' (straight-line fallback — OSRM unavailable)' : ''}</Popup>
                </Marker>
              </>
            )}
            <FitToRoute route={route} />
          </MapContainer>
          {editing && (
            <Suspense fallback={<div className="map-loading">Loading editor…</div>}>
              <div className="editor-overlay">
                <GeofenceEditor
                  editing={typeof editing === 'object' ? editing : null}
                  busy={busy}
                  onSave={handleSave}
                  onCancel={() => setEditing(null)}
                />
              </div>
            </Suspense>
          )}
        </section>

        <section className="table-wrap zones-side">
          <Suspense fallback={<div className="map-loading">Loading route panel…</div>}>
            <RoutePanel geofences={geofences} onRouteChange={setRoute} />
          </Suspense>

          <h2 className="side-h">Geofences ({geofences.length})</h2>
          <table className="fixes-table">
            <thead>
              <tr><th>Name</th><th>Kind</th><th>Category</th><th>Vehicle</th>{canWrite && <th />}</tr>
            </thead>
            <tbody>
              {geofences.map((g) => {
                const st = gfState?.states.find((s) => s.geofence_id === g.geofence_id);
                return (
                  <tr key={g.geofence_id}>
                    <td>{g.name}{!g.active && ' (inactive)'}</td>
                    <td>{g.kind === 'CIRCLE' ? `⌀ ${(Number(g.radius_m!) / 1000).toFixed(2)} km` : `${(g.ring?.length ?? 0) - 1} pts`}</td>
                    <td>{g.category}</td>
                    <td>{st ? (st.inside ? <span className="gf-inside">inside</span> : <span className="muted">outside</span>) : '—'}</td>
                    {canWrite && (
                      <td className="row-actions">
                        <button onClick={() => setEditing(g)}>Edit</button>
                        <button onClick={() => void handleDelete(g)} disabled={!g.active}>Deactivate</button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {geofences.length === 0 && (
                <tr><td colSpan={5} className="muted">No geofences yet — {canWrite ? 'draw one on the map.' : 'ask a fleet manager to define zones.'}</td></tr>
              )}
            </tbody>
          </table>
          {selectedDriver && (
            <div className="muted pad">Vehicle context: {selectedDriver.full_name} · last fix {gfState?.last_fix_at ?? 'n/a'}</div>
          )}
        </section>
      </main>

      <footer>
        Phase 3 — geofence CRUD (PostGIS), crossing events via ingest hook, OSRM routes with Redis cache (§1.10.2).
        Writes are audit-logged server-side (PDPP §1.7).
      </footer>
    </div>
  );
}
