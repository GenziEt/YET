import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from '../components/AuthGate';
import {
  createFleet,
  getAdminTrailers,
  getAdminVehicles,
  getFleets,
  handleUnauthorized,
  setFleetStatus,
  type AdminTrailerRow,
  type AdminVehicleRow,
  type FleetRow,
} from '../lib/api';

/**
 * Phase 5 audit follow-up — asset management: trucks, trailers and fleets in
 * one place. Reads mirror the shipped contracts (GET /admin/vehicles,
 * /admin/trailers, /fleets). The only writes exposed are the ones the backend
 * actually offers from the dashboard side: ADMIN fleet provisioning
 * (POST /fleets) and tenant suspend/reactivate (PATCH /fleets/:id/status).
 * Vehicle rows themselves are created through the driver/B2B assignment flow
 * (DriversPage), so this screen links there instead of faking a truck CRUD.
 */

type Tab = 'trucks' | 'trailers' | 'fleets';

export default function AssetsPage() {
  const role = useSession();
  const isAdmin = role === 'ADMIN';

  const [tab, setTab] = useState<Tab>('trucks');
  const [vehicles, setVehicles] = useState<AdminVehicleRow[]>([]);
  const [trailers, setTrailers] = useState<AdminTrailerRow[]>([]);
  const [fleets, setFleets] = useState<FleetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [search, setSearch] = useState('');

  // Fleet provisioning form (ADMIN only — mirrors POST /fleets zod body).
  const [newFleetName, setNewFleetName] = useState('');
  const [newFleetRef, setNewFleetRef] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!role) return; // /admin/* reads need a manager JWT (401 otherwise)
    setLoading(true);
    try {
      const [v, t, f] = await Promise.all([getAdminVehicles(), getAdminTrailers(), getFleets()]);
      setVehicles(v.vehicles);
      setTrailers(t.trailers);
      setFleets(f.fleets);
      setError(null);
    } catch (e) {
      handleUnauthorized(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [role]);

  useEffect(() => { void load(); }, [load]);

  const q = search.trim().toLowerCase();
  const shownVehicles = useMemo(
    () => (q ? vehicles.filter((v) => `${v.plate_number} ${v.make_model ?? ''} ${v.current_driver?.full_name ?? ''} ${v.fleet_name}`.toLowerCase().includes(q)) : vehicles),
    [vehicles, q],
  );
  const shownTrailers = useMemo(
    () => (q ? trailers.filter((t) => `${t.plate_number} ${t.trailer_type ?? ''} ${t.current_driver?.full_name ?? ''}`.toLowerCase().includes(q)) : trailers),
    [trailers, q],
  );

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'ok', text: label });
      void load();
    } catch (e) {
      setMsg({ kind: 'err', text: `${label} failed (${e instanceof Error ? e.message : e})` });
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Vehicles &amp; fleets</h1>
        <p className="page-sub">
          Asset directory across the platform. Trucks become assignable through the Drivers page
          (B2B flow: verify → fleet → truck → trailer); admins can provision and suspend fleets here.
        </p>
      </header>

      <div className="toolbar" role="group" aria-label="Asset filters">
        <div role="tablist" aria-label="Asset type">
          {(['trucks', 'trailers', 'fleets'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t}
              className={`chip${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t === 'trucks' ? `Trucks (${vehicles.length})` : t === 'trailers' ? `Trailers (${trailers.length})` : `Fleets (${fleets.length})`}
            </button>
          ))}
        </div>
        {tab !== 'fleets' && (
          <input type="search" placeholder="Plate, driver or fleet…" value={search}
            onChange={(e) => setSearch(e.target.value)} aria-label="Search assets" />
        )}
        <button className="btn small" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="banner err" role="alert">{error}</div>}
      {msg && <div className={`banner ${msg.kind === 'ok' ? 'ok' : 'err'}`} role="status">{msg.text}</div>}

      {tab === 'trucks' && (
        <table className="data-table">
          <thead>
            <tr><th>Plate</th><th>Type / body</th><th>Capacity</th><th>Ownership</th><th>Fleet</th><th>Current driver</th></tr>
          </thead>
          <tbody>
            {shownVehicles.map((v) => (
              <tr key={v.id}>
                <td><strong>{v.plate_number}</strong></td>
                <td>{v.vehicle_type ?? '—'} · {v.body_type ?? '—'}</td>
                <td>{v.capacity_tons != null ? `${v.capacity_tons} t` : '—'}</td>
                <td>{v.ownership_status ?? '—'}</td>
                <td>{v.fleet_name}</td>
                <td>
                  {v.current_driver ? (
                    <>
                      {v.current_driver.full_name}
                      <div className="muted small">since {new Date(v.current_driver.assigned_at).toLocaleDateString()}</div>
                    </>
                  ) : <span className="muted">unassigned</span>}
                </td>
              </tr>
            ))}
            {!loading && shownVehicles.length === 0 && (
              <tr><td colSpan={6} className="muted center">
                No trucks yet — they appear when drivers are verified and assigned on the Drivers page.
              </td></tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'trailers' && (
        <table className="data-table">
          <thead>
            <tr><th>Plate</th><th>Type</th><th>Capacity</th><th>Equipment</th><th>Fleet</th><th>Current driver</th></tr>
          </thead>
          <tbody>
            {shownTrailers.map((t) => (
              <tr key={t.id}>
                <td><strong>{t.plate_number}</strong></td>
                <td>{t.trailer_type ?? '—'}</td>
                <td>{t.capacity_tons != null ? `${t.capacity_tons} t` : '—'}</td>
                <td className="small">{t.equipment_details ?? '—'}</td>
                <td>{t.fleet_id ? (fleets.find((f) => f.id === t.fleet_id)?.name ?? '—') : <span className="muted">unowned</span>}</td>
                <td>{t.current_driver ? t.current_driver.full_name : <span className="muted">unassigned</span>}</td>
              </tr>
            ))}
            {!loading && shownTrailers.length === 0 && (
              <tr><td colSpan={6} className="muted center">No trailers registered yet.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'fleets' && (
        <>
          {isAdmin && (
            <form
              className="action-row"
              aria-label="Provision new fleet"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newFleetName.trim()) return;
                setCreating(true);
                void runAction(`Fleet “${newFleetName.trim()}” created`, () =>
                  createFleet(newFleetName.trim(), newFleetRef.trim() || undefined),
                ).finally(() => {
                  setCreating(false);
                  setNewFleetName('');
                  setNewFleetRef('');
                });
              }}
            >
              <input placeholder="New fleet name" value={newFleetName}
                onChange={(e) => setNewFleetName(e.target.value)} aria-label="Fleet name" />
              <input placeholder="Agreement ref (optional)" value={newFleetRef}
                onChange={(e) => setNewFleetRef(e.target.value)} aria-label="Agreement reference" />
              <button className="btn small" disabled={creating || !newFleetName.trim()}>
                {creating ? 'Creating…' : 'Create fleet'}
              </button>
            </form>
          )}
          <table className="data-table">
            <thead>
              <tr><th>Fleet</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {fleets.map((f) => (
                <tr key={f.id}>
                  <td><strong>{f.name}</strong></td>
                  <td>
                    <span className={`badge ${f.status === 'ACTIVE' ? 'badge-ok' : 'badge-err'}`}>
                      {f.status.toLowerCase()}
                    </span>
                  </td>
                  <td>
                    {isAdmin && (
                      f.status === 'ACTIVE' ? (
                        <button className="btn small danger"
                          onClick={() => void runAction(`Fleet “${f.name}” suspended`, () => setFleetStatus(f.id, 'SUSPENDED'))}>
                          Suspend
                        </button>
                      ) : (
                        <button className="btn small ok"
                          onClick={() => void runAction(`Fleet “${f.name}” reactivated`, () => setFleetStatus(f.id, 'ACTIVE'))}>
                          Reactivate
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
              {!loading && fleets.length === 0 && (
                <tr><td colSpan={3} className="muted center">No fleets registered.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {loading && <div className="muted center">Loading assets…</div>}
    </div>
  );
}
