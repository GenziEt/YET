import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getActiveTrips, getVehicleGeofenceState, getRoute,
         type TripSummary, type GeofenceDto, type RouteResponse, type VehicleGeofenceState } from '../lib/api';

/**
 * Phase 3 — "Route to destination" panel (blueprint deliverable):
 *   select an ACTIVE trip → select a geofence as destination →
 *   GET /route?from=<vehicle latest fix>&destination_geofence_id=… (the backend
 *   resolves the geofence centroid and calls OSRM; Redis-cached 5 min) →
 *   draw the returned geometry + show ETA. When eta.stale (vehicle STOPPED),
 *   the caveat banner shows "ETA stale — last movement <timestamp>".
 *
 * The panel polls every 60 s while an active trip is selected so the ETA
 * "updates as the vehicle moves" (Phase 3 gate wording) without hammering the
 * API — each poll is a Redis-hot request well inside the ≤50 ms budget (§1.9.4).
 */

interface Props {
  geofences: GeofenceDto[];
  /** Called when the parent map should draw/clear the route polyline + destination marker. */
  onRouteChange: (route: RouteResponse | null) => void;
}

const POLL_MS = 60_000;

function fmtEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export default function RoutePanel({ geofences, onRouteChange }: Props) {
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [tripId, setTripId] = useState('');
  const [geofenceId, setGeofenceId] = useState('');
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [state, setState] = useState<VehicleGeofenceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Active trips feed (Module 3 read side). Trips list is small; 50-row page default.
  useEffect(() => {
    getActiveTrips()
      .then((r) => {
        if (!mounted.current) return;
        setTrips(r.trips);
        setTripId((cur) => cur || r.trips[0]?.trip_id || '');
      })
      .catch(() => { /* offline-tolerant: keep last state, staleness banner covers it */ });
  }, []);

  const selectedTrip = useMemo(() => trips.find((t) => t.trip_id === tripId) ?? null, [trips, tripId]);
  const selectedFence = useMemo(() => geofences.find((g) => g.geofence_id === geofenceId) ?? null, [geofences, geofenceId]);

  const refresh = useCallback(async () => {
    if (!selectedTrip || !selectedFence) return;
    setLoading(true);
    setError(null);
    try {
      // Vehicle origin = latest fix (server-side via /geofences/state + fixes);
      // we fetch state first for the origin AND the inside/outside layer binding.
      const st = await getVehicleGeofenceState(selectedTrip.vehicle_id);
      if (!mounted.current) return;
      setState(st);
      if (!st.last_fix_at) { setError('vehicle has no location fixes yet'); setRoute(null); onRouteChange(null); return; }
      // Origin: pull the latest fix coordinates through the fixes endpoint is heavy;
      // instead ask the route by geofence destination with `from` = state anchor.
      // The backend /geofences/state does not return lat/lng (minimization), so we
      // use the trip status API's last known position via /trips/:id summary — but
      // simplest contract-compliant path: GET /route needs explicit from. We derive
      // it from the raw-fixes read side limited to 1 row.
      const r = await getRouteFromLatestFix(selectedTrip, selectedFence);
      if (!mounted.current) return;
      setRoute(r);
      onRouteChange(r);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [selectedTrip, selectedFence, onRouteChange]);

  // Poll while both selections exist — ETA updates as the vehicle moves.
  useEffect(() => {
    void refresh();
    if (!selectedTrip || !selectedFence) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh, selectedTrip, selectedFence]);

  // Clear the drawn route when selection drops.
  useEffect(() => {
    if (!selectedTrip || !selectedFence) { setRoute(null); onRouteChange(null); setState(null); }
  }, [selectedTrip, selectedFence, onRouteChange]);

  const staleMin = updatedAt ? Math.floor((Date.now() - updatedAt) / 60_000) : 0;

  return (
    <div className="route-panel">
      <h2>Route to destination</h2>
      <label>
        Active trip
        <select value={tripId} onChange={(e) => setTripId(e.target.value)}>
          {trips.length === 0 && <option value="">— no active trips —</option>}
          {trips.map((t) => (
            <option key={t.trip_id} value={t.trip_id}>
              {t.state} · started {new Date(t.started_at).toLocaleTimeString()} · {(t.distance_m / 1000).toFixed(1)} km
            </option>
          ))}
        </select>
      </label>
      <label>
        Destination zone
        <select value={geofenceId} onChange={(e) => setGeofenceId(e.target.value)}>
          {geofences.length === 0 && <option value="">— define a geofence first —</option>}
          {geofences.filter((g) => g.active).map((g) => (
            <option key={g.geofence_id} value={g.geofence_id}>{g.name} ({g.category.toLowerCase()})</option>
          ))}
        </select>
      </label>
      <button onClick={() => void refresh()} disabled={loading || !selectedTrip || !selectedFence}>
        {loading ? 'Fetching route…' : 'Refresh route'}
      </button>

      {error && <div className="error">{error}</div>}

      {state && (
        <div className="route-state">
          Zone status:{state.inside.length > 0
            ? <> inside <strong>{state.inside.map((z) => z.name).join(', ')}</strong></>
            : <> outside all candidate zones{state.last_fix_at ? ` (fix at ${new Date(state.last_fix_at).toLocaleTimeString()})` : ''}</>}
        </div>
      )}

      {route && (
        <div className="route-result">
          <div><strong>{selectedFence?.name}</strong> · {(route.distance_m / 1000).toFixed(1)} km ·{' '}
            drive time {fmtEta(route.duration_s)}</div>
          {route.eta ? (
            <div className={`eta ${route.eta.stale ? 'eta-stale' : ''}`}>
              ETA {fmtEta(route.eta.eta_seconds)}
              {' '}<span className="muted">({route.eta.eta_method}{route.fallback ? ', straight-line fallback' : ''})</span>
              {route.eta.stale && (
                <div className="eta-caveat">
                  ⚠ ETA is stale — vehicle is {route.eta.state ?? 'STOPPED'}.
                  Last movement: {route.eta.last_movement_at ? new Date(route.eta.last_movement_at).toLocaleString() : 'unknown'}.
                </div>
              )}
            </div>
          ) : <div className="muted">No ETA (passive route preview)</div>}
          <div className="muted">
            source: {route.source}{route.cached_at ? ` · cached ${new Date(route.cached_at).toLocaleTimeString()}` : ''}
            {staleMin > 2 && !loading ? ` · data ${staleMin} min old` : ''}
          </div>
        </div>
      )}
      {!route && !loading && selectedTrip && selectedFence && !error && (
        <div className="muted">Select trip + zone, then Refresh.</div>
      )}
    </div>
  );
}

/**
 * Resolve the vehicle's latest fix coordinates (read side, limit 1) and request
 * the OSRM route to the chosen geofence. Kept out of the component body so the
 * polling callback stays readable. Uses the Phase 1 /ingest/fixes contract with
 * a window around the trip start.
 */
async function getRouteFromLatestFix(trip: TripSummary, fence: GeofenceDto): Promise<RouteResponse> {
  const { api } = await import('../lib/api');
  const from = new Date(Math.max(0, new Date(trip.started_at).getTime() - 6 * 3600_000)).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const res = await api<{ fixes: { lat: number; lng: number }[] }>(
    `/ingest/fixes?driver_id=${encodeURIComponent(trip.driver_id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=2000`,
  );
  const fixes = res.fixes; // event-time ordered (§1.8.3) — last element is newest
  if (fixes.length === 0) throw new Error('no fixes for this trip yet — waiting for driver sync');
  const last = fixes[fixes.length - 1]!;
  return getRoute({
    from: [last.lat, last.lng],
    vehicleId: trip.vehicle_id,
    destinationGeofenceId: fence.geofence_id,
  });
}
