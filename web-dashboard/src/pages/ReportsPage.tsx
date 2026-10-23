import { useCallback, useEffect, useState } from 'react';
import {
  getTripReport, getSeparations, login, currentRole, hasToken, logout,
  type TripReportDto, type SeparationsDto,
} from '../lib/api';
import { toCsv, downloadBlob } from '../lib/csv';

/**
 * Phase 5 (D) — Fleet Reports page: weekly trip report + separation incident
 * history (§Master Module 6 "export a weekly trip report", §1.4 separations).
 * Reads go through /reports/* which require a FLEET_MANAGER/ADMIN JWT and are
 * audited server-side; CSV export is purely client-side (lib/csv.ts).
 */

const DAY = 24 * 3600_000;

function defaultWindow(): { fromIso: string; toIso: string } {
  const now = Date.now();
  // Default: last 7 days ending now (ISO with ms — zod .datetime() requires full form).
  return { fromIso: new Date(now - 7 * DAY).toISOString(), toIso: new Date(now).toISOString() };
}

type Tab = 'trips' | 'separations';

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('trips');
  const [creds, setCreds] = useState({ identifier: '', password: '' });
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(hasToken() && ['FLEET_MANAGER', 'ADMIN'].includes(currentRole() ?? ''));
  const [win, setWin] = useState(defaultWindow);
  const [trips, setTrips] = useState<TripReportDto | null>(null);
  const [seps, setSeps] = useState<SeparationsDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      if (tab === 'trips') setTrips(await getTripReport({ fromIso: win.fromIso, toIso: win.toIso }));
      else setSeps(await getSeparations({ fromIso: win.fromIso, toIso: win.toIso }));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, [tab, win]);

  useEffect(() => { if (signedIn) void load(); }, [signedIn, load]);

  const doLogin = async () => {
    setAuthMsg(null);
    try {
      const { role } = await login(creds.identifier, creds.password);
      if (role !== 'FLEET_MANAGER' && role !== 'ADMIN') {
        setAuthMsg(`Signed in as ${role} — reports need fleet-manager rights.`);
        logout();
      } else setSignedIn(true);
    } catch {
      setAuthMsg('Login failed.');
    }
  };

  const exportCsv = () => {
    const stamp = `${win.fromIso.slice(0, 10)}_${win.toIso.slice(0, 10)}`;
    if (tab === 'trips' && trips) {
      const csv = toCsv(
        ['trip_id', 'plate_number', 'driver_id', 'started_at', 'ended_at', 'state',
         'distance_km', 'moving_min', 'stopped_min', 'turn_count', 'harsh_event_count'],
        trips.trips.map((t) => [
          t.trip_id, t.plate_number ?? '', t.driver_id, t.started_at, t.ended_at ?? '', t.state,
          Math.round((t.distance_m / 1000) * 100) / 100,
          Math.round(t.moving_duration_s / 6), // deciminutes → 1 decimal via round trick below
          Math.round(t.stopped_duration_s / 6),
          t.turn_count, t.harsh_event_count,
        ]).map((r) => {
          // convert the *10 integers back to one-decimal strings for readability
          r[7] = (Number(r[7]) / 10).toFixed(1);
          r[8] = (Number(r[8]) / 10).toFixed(1);
          return r;
        }),
      );
      downloadBlob(`yet_trip_report_${stamp}.csv`, csv);
    } else if (tab === 'separations' && seps) {
      const csv = toCsv(
        ['separation_id', 'plate_number', 'driver_name', 'status', 'separated_at', 'returned_at',
         'duration_min', 'truck_last_known_lat', 'truck_last_known_lng', 'distance_m', 'notified_fleet_manager'],
        seps.incidents.map((i) => [
          i.separation_id, i.plate_number ?? '', i.driver_name ?? '', i.status, i.separated_at,
          i.returned_at ?? '', i.duration_min != null ? (Math.round(i.duration_min * 10) / 10).toFixed(1) : '',
          i.truck_stop_lat ?? '', i.truck_stop_lng ?? '', i.distance_m ?? '', i.notified_fleet_manager,
        ]),
      );
      downloadBlob(`yet_separation_report_${stamp}.csv`, csv);
    }
  };

  if (!signedIn) {
    return (
      <main className="page" style={{ padding: 16, maxWidth: 480 }}>
        <h2>Fleet reports</h2>
        <p>Sign in with a fleet-manager account to read trip / separation reports (all reads are audited).</p>
        <input placeholder="email or +251 phone" value={creds.identifier}
               onChange={(e) => setCreds({ ...creds, identifier: e.target.value })} />
        <input placeholder="password" type="password" value={creds.password}
               onChange={(e) => setCreds({ ...creds, password: e.target.value })} />
        <button onClick={() => void doLogin()}>Sign in</button>
        {authMsg && <p>{authMsg}</p>}
      </main>
    );
  }

  return (
    <main className="page" style={{ padding: 16 }}>
      <h2>Fleet reports</h2>
      <div className="view-nav">
        <button className={tab === 'trips' ? 'active' : ''} onClick={() => setTab('trips')}>Weekly trips</button>
        <button className={tab === 'separations' ? 'active' : ''} onClick={() => setTab('separations')}>Separations</button>
      </div>
      <div style={{ margin: '8px 0', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label>from <input type="datetime-local" value={win.fromIso.slice(0, 16)}
          onChange={(e) => setWin((w) => ({ ...w, fromIso: new Date(e.target.value).toISOString() }))} /></label>
        <label>to <input type="datetime-local" value={win.toIso.slice(0, 16)}
          onChange={(e) => setWin((w) => ({ ...w, toIso: new Date(e.target.value).toISOString() }))} /></label>
        <button onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Run'}</button>
        <button onClick={exportCsv}
                disabled={(tab === 'trips' ? !trips : !seps)}>Export CSV</button>
        <button onClick={() => { logout(); setSignedIn(false); }}>Sign out</button>
      </div>
      {err && <p style={{ color: '#b00' }}>{err}</p>}

      {tab === 'trips' && trips && (
        <>
          <h3>Summary — {trips.window.from.slice(0, 10)} → {trips.window.to.slice(0, 10)}</h3>
          <p>
            {trips.summary.trip_count} trips · {trips.summary.total_distance_km} km ·{' '}
            {(trips.summary.total_moving_s / 3600).toFixed(1)} h moving ·{' '}
            {(trips.summary.total_stopped_s / 3600).toFixed(1)} h stopped ·{' '}
            {trips.summary.turn_count} turns · {trips.summary.harsh_event_count} harsh events
          </p>
          <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
            <thead><tr><th>Week (Mon)</th><th>Trips</th><th>Distance km</th></tr></thead>
            <tbody>
              {trips.weeks.map((w) => (
                <tr key={w.week_start}><td>{w.week_start}</td><td>{w.trips}</td><td>{w.distance_km}</td></tr>
              ))}
            </tbody>
          </table>
          <h3>Trips ({trips.trips.length})</h3>
          <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th>Plate</th><th>Started</th><th>Ended</th><th>State</th><th>km</th><th>Turns</th><th>Harsh</th></tr></thead>
            <tbody>
              {trips.trips.map((t) => (
                <tr key={t.trip_id}>
                  <td>{t.plate_number ?? '—'}</td>
                  <td>{new Date(t.started_at).toLocaleString()}</td>
                  <td>{t.ended_at ? new Date(t.ended_at).toLocaleString() : 'open'}</td>
                  <td>{t.state}</td>
                  <td>{(t.distance_m / 1000).toFixed(2)}</td>
                  <td>{t.turn_count}</td>
                  <td>{t.harsh_event_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === 'separations' && seps && (
        <>
          <h3>Separation incidents ({seps.count})</h3>
          <p style={{ fontSize: 13 }}>
            Truck positions below are <b>last known locations</b> at separation time — the truck does not
            phone home while the driver is away (§1.4).
          </p>
          <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th>Plate</th><th>Driver</th><th>Separated at</th><th>Returned</th><th>Min</th>
              <th>Last known truck pos</th><th>Dist m</th><th>Manager notified</th></tr></thead>
            <tbody>
              {seps.incidents.map((i) => (
                <tr key={i.separation_id}>
                  <td>{i.plate_number ?? '—'}</td>
                  <td>{i.driver_name ?? '—'}</td>
                  <td>{new Date(i.separated_at).toLocaleString()}</td>
                  <td>{i.returned_at ? new Date(i.returned_at).toLocaleString() : 'OPEN'}</td>
                  <td>{i.duration_min != null ? (Math.round(i.duration_min * 10) / 10).toFixed(1) : '—'}</td>
                  <td>{i.truck_stop_lat != null ? `${i.truck_stop_lat.toFixed(5)}, ${i.truck_stop_lng!.toFixed(5)}` : '—'}</td>
                  <td>{i.distance_m != null ? Math.round(i.distance_m) : '—'}</td>
                  <td>{i.notified_fleet_manager ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
