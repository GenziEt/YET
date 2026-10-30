import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { getDrivers, getFixes, type DriverRosterEntry, type LocationFixRow } from '../lib/api';

// §1.9.2: Leaflet chunk stays lazy — the picker/table render without it.
const FixTrailMap = lazy(() => import('../components/FixTrailMap'));

/** Local-date -> UTC ISO bounds for [date 00:00, date+1 00:00) local time. */
function dayBounds(dateStr: string): { from: string; to: string } {
  const start = new Date(`${dateStr}T00:00:00`); // local midnight
  const end = new Date(start.getTime() + 24 * 3600_000);
  return { from: start.toISOString(), to: end.toISOString() };
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const TABLE_PAGE_SIZE = 50; // §1.9.2: paginated lists, default 50 rows

export default function RawFixesPage() {
  const [drivers, setDrivers] = useState<DriverRosterEntry[]>([]);
  const [driversError, setDriversError] = useState<string | null>(null);
  const [driverId, setDriverId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [fixes, setFixes] = useState<LocationFixRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [tablePage, setTablePage] = useState(0);

  // Roster: drivers with fixes in the last 7 days (backend default `since`).
  useEffect(() => {
    let cancelled = false;
    getDrivers()
      .then((r) => {
        if (cancelled) return;
        setDrivers(r.drivers);
        setDriversError(null);
        setDriverId((cur) => cur || r.drivers[0]?.driver_id || '');
      })
      .catch((e: unknown) => !cancelled && setDriversError(String(e)));
    return () => { cancelled = true; };
  }, []);

  const loadFixes = useCallback(async () => {
    if (!driverId) return;
    setLoading(true);
    setError(null);
    try {
      const { from, to } = dayBounds(date);
      const r = await getFixes(driverId, from, to);
      setFixes(r.fixes); // already event-time ordered (§1.8.3) — do not re-sort
      setLoadedAt(Date.now());
      setTablePage(0);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setFixes([]);
    } finally {
      setLoading(false);
    }
  }, [driverId, date]);

  useEffect(() => { void loadFixes(); }, [loadFixes]);

  const selectedDriver = useMemo(
    () => drivers.find((d) => d.driver_id === driverId) ?? null,
    [drivers, driverId],
  );

  // §1.8.4 staleness banner — never an indefinite spinner over cached state.
  const staleMin = loadedAt ? Math.floor((Date.now() - loadedAt) / 60_000) : 0;

  const pageRows = fixes.slice(tablePage * TABLE_PAGE_SIZE, (tablePage + 1) * TABLE_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(fixes.length / TABLE_PAGE_SIZE));

  return (
    <div className="page">
      <header>
        <h1>Raw Location History</h1>
        <span className="pill">{fixes.length} fixes</span>
        {staleMin > 2 && !loading && <span className="pill warn">last updated {staleMin} min ago</span>}
        {loading && <span className="pill warn" role="status">loading…</span>}
      </header>

      <div className="toolbar">
        <label>
          Driver
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)} aria-label="Driver">
            {drivers.length === 0 && <option value="">— no active drivers —</option>}
            {drivers.map((d) => (
              <option key={d.driver_id} value={d.driver_id}>
                {d.full_name}{d.plate_number ? ` · ${d.plate_number}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
        </label>
        <button onClick={() => void loadFixes()} disabled={loading || !driverId}>Refresh</button>
        {driversError && <span className="error" role="alert">roster: {driversError}</span>}
      </div>

      {error && <div className="error banner" role="alert">GET /ingest/fixes failed: {error}</div>}
      {!error && !loading && fixes.length === 0 && driverId && (
        <div className="empty-note">
          No fixes for {selectedDriver?.full_name ?? 'this driver'} on {date}.
          {' '}Offline data appears here once the driver's app syncs (Phase 1 gate ≤ 60 s after reconnect).
        </div>
      )}

      <main className="split">
        <section className="map-wrap" aria-label="Trail map">
          <Suspense fallback={<div className="map-loading">Loading map…</div>}>
            <FixTrailMap fixes={fixes} />
          </Suspense>
        </section>
        <section className="table-wrap" aria-label="Fix rows">
          <table className="fixes-table">
            <caption className="visually-hidden">GPS fixes for the selected driver and date, 50 per page</caption>
            <thead>
              <tr>
                <th>#</th><th>Event time</th><th>Lat</th><th>Lng</th>
                <th>Speed m/s</th><th>Acc m</th><th>Provider</th><th>Batch</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((f, i) => (
                <tr key={`${f.batch_id}-${f.fix_timestamp}-${i}`}>
                  <td>{tablePage * TABLE_PAGE_SIZE + i + 1}</td>
                  <td>{new Date(f.fix_timestamp).toLocaleTimeString()}</td>
                  <td>{f.lat.toFixed(6)}</td>
                  <td>{f.lng.toFixed(6)}</td>
                  <td>{f.speed_mps ?? '—'}</td>
                  <td>{f.accuracy_m ?? '—'}</td>
                  <td>{f.provider ?? '—'}</td>
                  <td title={f.batch_id}>{f.batch_id.slice(0, 8)}</td>
                </tr>
              ))}
              {pageRows.length === 0 && (
                <tr><td colSpan={8} className="muted">{loading ? 'Loading…' : 'No rows'}</td></tr>
              )}
            </tbody>
          </table>
          <nav className="pager" aria-label="Table pagination">
            <button onClick={() => setTablePage((p) => Math.max(0, p - 1))} disabled={tablePage === 0} aria-label="Previous page">←</button>
            <span aria-live="polite">page {tablePage + 1} / {pageCount}</span>
            <button onClick={() => setTablePage((p) => Math.min(pageCount - 1, p + 1))} disabled={tablePage >= pageCount - 1} aria-label="Next page">→</button>
          </nav>
        </section>
      </main>

      <footer>
        Phase 1 — ingest spine read side. Reads are audit-logged server-side (PDPP §1.7).
        Trip-state coloring arrives in Phase 2.
      </footer>
    </div>
  );
}
