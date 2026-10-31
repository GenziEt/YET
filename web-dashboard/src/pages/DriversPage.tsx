import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  adminAssignTrailer,
  adminAssignVehicle,
  currentRole,
  getAdminDrivers,
  getAdminTrailers,
  getAdminVehicles,
  getDriverDossier,
  getFleets,
  moveDriverToFleet,
  reviewDriverDocument,
  revokeDriverDevice,
  setDriverActive,
  type AdminDriverRow,
  type AdminTrailerRow,
  type AdminVehicleRow,
  type DriverDossier,
  type DriverQueueStatus,
  type FleetRow,
} from '../lib/api';

/**
 * Module 1 — Drivers: onboarding review queue + mandatory B2B assignment.
 * Drivers never log in with a password (device pairing is their session), so
 * activation is entirely an admin workflow: verify documents → move to fleet
 * → assign truck/trailer. FLEET_MANAGER actions are scoped server-side to
 * their own fleet; ADMIN additionally gets the "move to fleet" picker.
 */

const STATUS_TABS: { id: DriverQueueStatus; label: string }[] = [
  { id: 'PENDING', label: 'Pending review' },
  { id: 'ACTIVE', label: 'Active' },
  { id: 'SUSPENDED', label: 'Suspended' },
  { id: 'ALL', label: 'All' },
];

function docBadgeTone(status: string): string {
  if (status === 'VERIFIED') return 'badge-ok';
  if (status === 'REJECTED') return 'badge-err';
  if (status === 'EXPIRED') return 'badge-warn';
  return 'badge-pending';
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export default function DriversPage() {
  const role = currentRole();
  const isAdmin = role === 'ADMIN';

  const [status, setStatus] = useState<DriverQueueStatus>('PENDING');
  const [search, setSearch] = useState('');
  const [drivers, setDrivers] = useState<AdminDriverRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dossier, setDossier] = useState<DriverDossier | null>(null);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Assignment pickers (lazy-loaded once per fleet-scope change).
  const [vehicles, setVehicles] = useState<AdminVehicleRow[] | null>(null);
  const [trailers, setTrailers] = useState<AdminTrailerRow[] | null>(null);
  const [fleets, setFleets] = useState<FleetRow[]>([]);
  const [vehiclePick, setVehiclePick] = useState('');
  const [trailerPick, setTrailerPick] = useState('');
  const [fleetPick, setFleetPick] = useState('');

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getAdminDrivers(status, search.trim() || undefined);
      setDrivers(r.drivers);
      setListError(null);
    } catch (e: unknown) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => {
    const t = setTimeout(() => void loadList(), search ? 300 : 0); // debounce typing
    return () => clearTimeout(t);
  }, [loadList, search]);

  const openDossier = useCallback(async (id: string) => {
    setSelectedId(id);
    setActionMsg(null);
    setDossierLoading(true);
    setDossier(null);
    setVehiclePick('');
    setTrailerPick('');
    setFleetPick('');
    try {
      const d = await getDriverDossier(id);
      setDossier(d);
      // Load pickers relevant to this driver's scope on first open only.
      if (!vehicles) getAdminVehicles().then((r) => setVehicles(r.vehicles)).catch(() => setVehicles([]));
      if (!trailers) getAdminTrailers().then((r) => setTrailers(r.trailers)).catch(() => setTrailers([]));
      if (isAdmin && fleets.length === 0) getFleets().then((r) => setFleets(r.fleets)).catch(() => {});
    } catch (e: unknown) {
      setActionMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDossierLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, vehicles, trailers, fleets.length]);

  const refreshAfterAction = useCallback(async (msg: string) => {
    setActionMsg({ kind: 'ok', text: msg });
    if (selectedId) {
      try { setDossier(await getDriverDossier(selectedId)); } catch { /* keep stale view */ }
    }
    void loadList();
  }, [selectedId, loadList]);

  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        await refreshAfterAction(label);
      } catch (e: unknown) {
        const code = e instanceof ApiError ? ` (${e.status})` : '';
        setActionMsg({ kind: 'err', text: `${label} failed${code}` });
      }
    },
    [refreshAfterAction],
  );

  const realFleets = useMemo(
    () => fleets.filter((f) => f.status === 'ACTIVE' && f.name !== 'Unassigned Fleet'),
    [fleets],
  );
  const freeVehicles = useMemo(
    () => (vehicles ?? []).filter((v) => !v.current_driver || v.current_driver.driver_id === dossier?.id),
    [vehicles, dossier?.id],
  );
  const freeTrailers = useMemo(
    () => (trailers ?? []).filter((t) => !t.current_driver || t.current_driver.driver_id === dossier?.id),
    [trailers, dossier?.id],
  );

  return (
    <div className="page">
      <header className="page-header">
        <h1>Drivers</h1>
        <p className="page-sub">
          Self-registered drivers (phone OTP + device pairing — no passwords). Verify documents,
          then make the mandatory B2B assignment: fleet → truck → trailer.
        </p>
      </header>

      <div className="toolbar" role="group" aria-label="Driver filters">
        <div role="tablist" aria-label="Queue status">
          {STATUS_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={status === t.id}
              className={`chip${status === t.id ? ' active' : ''}`}
              onClick={() => setStatus(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Name, phone, license or plate…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search drivers"
        />
      </div>

      {listError && <div className="banner err" role="alert">{listError}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>Driver</th><th>Phone</th><th>Fleet</th><th>Licence</th>
            <th>Documents</th><th>Truck</th><th>Trailers</th><th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {drivers.map((d) => {
            const lic = d.documents.find((x) => x.doc_type === 'DRIVING_LICENSE');
            const pending = d.documents.some((x) => x.status === 'PENDING_REVIEW');
            const rejected = d.documents.some((x) => x.status === 'REJECTED');
            return (
              <tr key={d.id} className={selectedId === d.id ? 'row-selected' : undefined}>
                <td>
                  <button className="link-btn" onClick={() => void openDossier(d.id)}>
                    {d.full_name}
                  </button>
                  <div className="muted small">{fmtDate(d.created_at)}</div>
                </td>
                <td>{d.phone_e164}</td>
                <td>{d.fleet_name}</td>
                <td>
                  {d.license_number ?? '—'}
                  <div className="muted small">exp {fmtDate(d.license_expiry)}</div>
                </td>
                <td>
                  {lic ? (
                    <span className={`badge ${docBadgeTone(lic.status)}`}>{lic.status.replace('_', ' ')}</span>
                  ) : (
                    <span className="badge badge-err">no licence</span>
                  )}
                </td>
                <td>{d.active_vehicle ? d.active_vehicle.plate_number : <span className="muted">unassigned</span>}</td>
                <td>{d.active_trailers}</td>
                <td>
                  {!d.is_active ? <span className="badge badge-err">suspended</span>
                    : rejected ? <span className="badge badge-err">docs rejected</span>
                    : pending ? <span className="badge badge-pending">pending review</span>
                    : <span className="badge badge-ok">active</span>}
                </td>
                <td><button className="btn small" onClick={() => void openDossier(d.id)}>Open</button></td>
              </tr>
            );
          })}
          {!loading && drivers.length === 0 && (
            <tr><td colSpan={9} className="muted center">No drivers match this filter.</td></tr>
          )}
        </tbody>
      </table>
      {loading && <div className="muted center">Loading…</div>}

      {/* Dossier drawer ---------------------------------------------------- */}
      {selectedId && (
        <aside className="drawer" aria-label="Driver dossier">
          <div className="drawer-head">
            <h2>{dossier?.full_name ?? 'Driver dossier'}</h2>
            <button className="btn ghost" onClick={() => { setSelectedId(null); setDossier(null); }}>Close</button>
          </div>

          {dossierLoading && <div className="muted">Loading dossier…</div>}
          {actionMsg && (
            <div className={`banner ${actionMsg.kind === 'ok' ? 'ok' : 'err'}`} role="status">{actionMsg.text}</div>
          )}

          {dossier && (
            <>
              <section>
                <h3>Identity</h3>
                <dl className="kv">
                  <dt>Phone</dt><dd>{dossier.phone_e164}</dd>
                  <dt>Licence</dt><dd>{dossier.license_number ?? '—'} ({dossier.license_class ?? '—'}) exp {fmtDate(dossier.license_expiry)}</dd>
                  <dt>Association</dt><dd>{dossier.association_name ?? '—'}</dd>
                  <dt>Home base</dt><dd>{dossier.home_base ?? '—'}</dd>
                  <dt>Ownership</dt><dd>{dossier.ownership_status ?? '—'}</dd>
                  <dt>Fleet</dt><dd>{dossier.fleet_name}</dd>
                </dl>
              </section>

              <section>
                <h3>Documents</h3>
                <ul className="doc-list">
                  {dossier.documents.map((doc) => (
                    <li key={doc.id}>
                      <span>{doc.doc_type.replace(/_/g, ' ')}</span>
                      <span className={`badge ${docBadgeTone(doc.status)}`}>{doc.status.replace('_', ' ')}</span>
                      {doc.status === 'PENDING_REVIEW' && (
                        <>
                          <button
                            className="btn small ok"
                            onClick={() => void runAction(`${doc.doc_type} verified`,
                              () => reviewDriverDocument(doc.id, 'VERIFIED'))}
                          >Verify</button>
                          <button
                            className="btn small danger"
                            onClick={() => void runAction(`${doc.doc_type} rejected`,
                              () => reviewDriverDocument(doc.id, 'REJECTED', 'Unclear or invalid document'))}
                          >Reject</button>
                        </>
                      )}
                      {doc.review_note && <em className="muted small">{doc.review_note}</em>}
                    </li>
                  ))}
                  {dossier.documents.length === 0 && <li className="muted">No documents uploaded yet.</li>}
                </ul>
              </section>

              <section aria-label="Assignment actions">
                <h3>B2B assignment</h3>
                {isAdmin && (
                  <div className="action-row">
                    <select value={fleetPick} onChange={(e) => setFleetPick(e.target.value)} aria-label="Target fleet">
                      <option value="">Move to fleet…</option>
                      {realFleets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                    <button
                      className="btn small" disabled={!fleetPick}
                      onClick={() => void runAction('Driver moved to fleet', () => moveDriverToFleet(dossier.id, fleetPick))}
                    >Move</button>
                  </div>
                )}
                <div className="action-row">
                  <select value={vehiclePick} onChange={(e) => setVehiclePick(e.target.value)} aria-label="Truck">
                    <option value="">Assign truck…</option>
                    {freeVehicles.map((v) => (
                      <option key={v.id} value={v.id}>{v.plate_number} · {v.body_type ?? v.vehicle_type ?? 'truck'} · {v.fleet_name}</option>
                    ))}
                  </select>
                  <button
                    className="btn small" disabled={!vehiclePick}
                    onClick={() => void runAction('Truck assigned', () => adminAssignVehicle(dossier.id, vehiclePick))}
                  >Assign</button>
                </div>
                <div className="action-row">
                  <select value={trailerPick} onChange={(e) => setTrailerPick(e.target.value)} aria-label="Trailer">
                    <option value="">Assign trailer…</option>
                    {freeTrailers.map((t) => (
                      <option key={t.id} value={t.id}>{t.plate_number} · {t.trailer_type ?? 'trailer'}</option>
                    ))}
                  </select>
                  <button
                    className="btn small" disabled={!trailerPick}
                    onClick={() => void runAction('Trailer assigned', () => adminAssignTrailer(dossier.id, trailerPick))}
                  >Assign</button>
                </div>
              </section>

              <section>
                <h3>Current equipment</h3>
                <p>
                  Truck: {dossier.active_vehicle
                    ? <>{dossier.active_vehicle.plate_number}{dossier.active_vehicle.made_by_admin ? ' (admin)' : ' (self)'}</>
                    : <span className="muted">none</span>}
                  {' · Trailers active: '}{dossier.active_trailers}
                </p>
                <details>
                  <summary>Truck history</summary>
                  <ul>
                    {dossier.vehicle_history.map((h, i) => (
                      <li key={`${h.vehicle_id}-${i}`}>
                        {h.plate_number}: {fmtDate(h.assigned_at)} → {h.unassigned_at ? fmtDate(h.unassigned_at) : 'current'}
                        {h.created_by_admin ? ' (admin)' : ' (self)'}
                      </li>
                    ))}
                  </ul>
                </details>
              </section>

              <section>
                <h3>Devices & account</h3>
                <ul className="doc-list">
                  {dossier.devices.map((dev) => (
                    <li key={dev.id}>
                      <span>{dev.platform ?? 'android'} · {dev.device_id.slice(0, 8)}…</span>
                      {dev.revoked_at
                        ? <span className="badge badge-err">revoked {fmtDate(dev.revoked_at)}</span>
                        : (
                          <button
                            className="btn small danger"
                            onClick={() => void runAction('Device revoked — driver must re-pair via OTP',
                              () => revokeDriverDevice(dossier.id, dev.device_id, 'admin_revoke'))}
                          >Revoke</button>
                        )}
                    </li>
                  ))}
                  {dossier.devices.length === 0 && <li className="muted">No paired devices.</li>}
                </ul>
                <div className="action-row">
                  {dossier.is_active ? (
                    <button
                      className="btn danger"
                      onClick={() => void runAction('Driver suspended', () => setDriverActive(dossier.id, false))}
                    >Suspend driver</button>
                  ) : (
                    <button
                      className="btn ok"
                      onClick={() => void runAction('Driver reactivated (current device restored)',
                        () => setDriverActive(dossier.id, true))}
                    >Reactivate driver</button>
                  )}
                </div>
              </section>
            </>
          )}
        </aside>
      )}
    </div>
  );
}
