import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { TILE_URL, ATTRIBUTION, ADDIS_ABABA, DEFAULT_ZOOM } from '../config';
import { getFleetState, hasToken, type FleetStateDto, type FleetVehicleStateDto } from '../lib/api';

const liveIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34],
});
// §1.4 honesty rule: a stale/offline truck must NEVER look live — gray, hollow marker.
const staleIcon = L.divIcon({
  className: '',
  html: '<div style="width:18px;height:18px;border-radius:50%;background:#bbb;border:3px solid #777;opacity:.85"></div>',
  iconSize: [18, 18], iconAnchor: [9, 9],
});

/** "last known location @ 14:05" style label built from event-time fields only. */
export function fixAgeLabel(v: FleetVehicleStateDto): string {
  if (!v.last_fix) return 'no fixes received';
  const t = new Date(v.last_fix.at);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (v.is_live) return `live · ${hhmm}`;
  const age = v.last_fix_age_s ?? 0;
  const human = age >= 60 ? `${Math.round(age / 60)} min` : `${age} s`;
  return `last known location @ ${hhmm} (${human} ago)`;
}

/**
 * Phase 5 (D): live fleet map fed by GET /reports/fleet-state (Redis-cached 30s
 * server-side, §1.10.2). Poll cadence 30s matches the cache TTL — faster polling
 * would just hit the same snapshot. Markers are labeled with is_live/last_fix_age_s
 * so offline trucks render as "last known location @ <time>" (§1.4), and the
 * replica_lag_s annotation says "data may be Xs behind" instead of pretending freshness.
 */
export default function FleetMap() {
  const [state, setState] = useState<FleetStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasToken()) { setError('Sign in as fleet manager to view the live fleet.'); return; }
    let alive = true;
    const load = () =>
      getFleetState()
        .then((s) => { if (alive) { setState(s); setError(null); } })
        .catch((e) => { if (alive) setError(String(e)); });
    load();
    const id = setInterval(load, 30_000); // poll == server TTL; cache absorbs the storm
    return () => { alive = false; clearInterval(id); };
  }, []);

  const center = useMemo<[number, number]>(() => {
    const first = state?.vehicles.find((v) => v.last_fix);
    return first?.last_fix ? [first.last_fix.lat, first.last_fix.lng] : ADDIS_ABABA;
  }, [state]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '6px 10px', background: '#fffbe6', borderBottom: '1px solid #ddd', fontSize: 13 }}>
        {error && <span style={{ color: '#b00' }}>{error}</span>}
        {state && (
          <span>
            {state.counts.total} vehicles · {state.counts.on_trip} on trip ·{' '}
            {state.counts.separated_open} separated open · {state.counts.offline} offline/stale
            {' — snapshot '}
            {new Date(state.generated_at).toLocaleTimeString()}
            {state.cached ? ' (cached)' : ''}
            {state.replica_lag_s != null && state.replica_lag_s > 5 ? ` · data may be ${state.replica_lag_s}s behind` : ''}
          </span>
        )}
      </div>
      <div style={{ flex: 1 }}>
        <MapContainer center={center} zoom={DEFAULT_ZOOM} style={{ height: '100%', width: '100%' }} attributionControl>
          <TileLayer url={TILE_URL} attribution={ATTRIBUTION} maxZoom={19} />
          {(state?.vehicles ?? []).map((v) => {
            if (!v.last_fix) return null;
            const pos: [number, number] = [v.last_fix.lat, v.last_fix.lng];
            return (
              <Marker key={v.vehicle_id} position={pos} icon={v.is_live ? liveIcon : staleIcon}>
                <Popup>
                  <b>{v.plate_number ?? v.vehicle_id.slice(0, 8)}</b>
                  {v.driver_name ? ` — ${v.driver_name}` : ''}
                  <br />
                  <i>{fixAgeLabel(v)}</i>
                  {v.trip && (
                    <>
                      <br />
                      trip {v.trip.state.toLowerCase()} since {new Date(v.trip.started_at).toLocaleTimeString()}
                      {v.trip.separation_open && (
                        <>
                          <br />
                          <b style={{ color: '#b00' }}>
                            driver separated {v.trip.separated_minutes ?? '?'} min{v.trip.notified ? ' · manager notified' : ''}
                          </b>
                        </>
                      )}
                    </>
                  )}
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>
    </div>
  );
}
