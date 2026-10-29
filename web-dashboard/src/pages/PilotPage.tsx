import { useCallback, useEffect, useState } from 'react';
import { getPilotReport, DriverRosterEntry, PilotReportDto } from '../lib/api';

/**
 * Phase 4 — Field pilot dashboard (Module 6 Reporting, read-only).
 * Binds GET /reports/pilot. The two hard gates (§Phase 4):
 *   • Battery: median drain ≤ target (20%) PASS; > gate max (25%) ⇒ GATE_FAIL,
 *     return to Phase 2 and tune sensor gating before proceeding.
 *   • Offline reconstruction accuracy ≥ 95% of offline-period fixes.
 * Thresholds are rendered FROM the server payload, never hardcoded here.
 */

const todayStr = () => new Date().toISOString().slice(0, 10);

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

export default function PilotPage() {
  const [drivers, setDrivers] = useState<DriverRosterEntry[]>([]);
  const [driverId, setDriverId] = useState('');
  const [fromDays, setFromDays] = useState(7);
  const [report, setReport] = useState<PilotReportDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  useEffect(() => {
    // Roster for the optional per-driver filter (same endpoint as Raw fixes view).
    void import('../lib/api').then(({ getDrivers }) =>
      getDrivers().then((r) => setDrivers(r.drivers)).catch(() => undefined),
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getPilotReport({
        fromIso: daysAgoIso(fromDays),
        toIso: new Date().toISOString(),
        driverId: driverId || undefined,
      });
      setReport(r);
      setLoadedAt(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [fromDays, driverId]);

  useEffect(() => { void load(); }, [load]);

  const staleMin = loadedAt ? Math.floor((Date.now() - loadedAt) / 60000) : 0;
  const b = report?.battery;
  const rec = report?.reconstruction_audit;

  return (
    <div className="page">
      <header>
        <img className="brand-logo" src="/met-logo.svg" alt="MET" />
        <h1>Pilot telemetry</h1>
        <span className="pill">{todayStr()}</span>
        {staleMin > 2 && !loading && <span className="pill warn">last updated {staleMin} min ago</span>}
        {loading && <span className="pill warn">loading…</span>}
      </header>

      <div className="picker-bar">
        <label>
          Window
          <select value={fromDays} onChange={(e) => setFromDays(Number(e.target.value))}>
            <option value={3}>last 3 days</option>
            <option value={7}>last 7 days</option>
            <option value={14}>last 14 days</option>
          </select>
        </label>
        <label>
          Driver
          <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">all (fleet)</option>
            {drivers.map((d) => (
              <option key={d.driver_id} value={d.driver_id}>
                {d.full_name}{d.plate_number ? ` — ${d.plate_number}` : ''}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => void load()} disabled={loading}>Refresh</button>
      </div>

      {error && <div className="error banner">GET /reports/pilot failed: {error}</div>}
      {!error && !report && !loading && <div className="empty-note">No pilot data yet.</div>}

      {report && (
        <main className="pilot-grid">
          {/* ---- Battery gate banner (PASS / GATE_FAIL) ---- */}
          <section className={`gate-banner verdict-${b!.verdict.toLowerCase()}`}>
            <div className="gate-headline">
              {b!.verdict === 'PASS' && <>✅ PASS — median {b!.median_pct_per_8h}% / 8h shift (target ≤ {report.thresholds.target_pct_per_8h}%)</>}
              {b!.verdict === 'GATE_FAIL' && <>⛔ GATE_FAIL — median {b!.median_pct_per_8h}% / 8h exceeds {report.thresholds.gate_max_pct_per_8h}% → return to Phase 2, tune sensor gating</>}
              {b!.verdict === 'BETWEEN_TARGET_AND_GATE' && <>⚠️ AT RISK — median {b!.median_pct_per_8h}% is above target {report.thresholds.target_pct_per_8h}% but under gate {report.thresholds.gate_max_pct_per_8h}%</>}
              {b!.verdict === 'INSUFFICIENT_DATA' && <>⏳ INSUFFICIENT_DATA — {b!.trips_measured} usable trips (need more battery start/end samples)</>}
            </div>
            <div className="gate-sub">
              trips with samples: {b!.trips_with_samples} · usable: {b!.trips_measured} ·
              p90: {b!.p90_pct_per_8h ?? '—'}% · thresholds {report.thresholds.target_pct_per_8h}%/{report.thresholds.gate_max_pct_per_8h}%
            </div>
          </section>

          {/* ---- Reconstruction audit ---- */}
          <section className="card">
            <h2>Offline reconstruction (§1.8)</h2>
            <div className={`big-number ${rec!.gate_passed ? 'ok' : 'bad'}`}>
              {(rec!.accuracy * 100).toFixed(2)}%
              <span className="verdict-tag">{rec!.gate_passed ? 'PASS' : 'FAIL'}</span>
            </div>
            <div className="card-note">
              {rec!.offline_stored}/{rec!.offline_sent} offline-collected fixes stored across {rec!.offline_batches} late batches
              (gate ≥ {(report.thresholds.reconstruction_min_accuracy * 100).toFixed(0)}%)
            </div>
          </section>

          {/* ---- Upload latency + backlog ---- */}
          <section className="card">
            <h2>Upload latency &amp; sync backlog</h2>
            <table className="kv-table">
              <tbody>
                <tr><td>p50</td><td>{report.upload_latency.p50_seconds ?? '—'} s</td></tr>
                <tr><td>p95</td><td>{report.upload_latency.p95_seconds ?? '—'} s</td></tr>
                <tr><td>batches</td><td>{report.upload_latency.batches}</td></tr>
                <tr><td>late fixes (&gt;10 min)</td><td>{report.sync_backlog.late_fixes} / {report.sync_backlog.total_fixes}</td></tr>
                <tr><td>worst lag</td><td>{report.sync_backlog.worst_lag_s} s</td></tr>
              </tbody>
            </table>
          </section>

          {/* ---- Per-driver drain ---- */}
          <section className="card">
            <h2>Battery drain per driver</h2>
            {report.per_driver.length === 0 ? (
              <div className="muted">No paired start/end battery samples in window.</div>
            ) : (
              <table className="fixes-table">
                <thead><tr><th>Driver</th><th>Plate</th><th>Trips</th><th>Median %/8h</th></tr></thead>
                <tbody>
                  {report.per_driver.map((d) => (
                    <tr key={d.driver_id}>
                      <td>{d.driver_name ?? d.driver_id.slice(0, 8)}</td>
                      <td>{d.plate_number ?? '—'}</td>
                      <td>{d.trips_measured}</td>
                      <td className={d.median_pct_per_8h != null && d.median_pct_per_8h > report.thresholds.gate_max_pct_per_8h ? 'cell-bad' : ''}>
                        {d.median_pct_per_8h ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ---- Separations ---- */}
          <section className="card">
            <h2>Driver separations</h2>
            {report.separations.length === 0 ? (
              <div className="muted">No separation events in window.</div>
            ) : (
              <table className="fixes-table">
                <thead><tr><th>Plate</th><th>Incidents</th><th>Open now</th><th>Avg minutes</th></tr></thead>
                <tbody>
                  {report.separations.map((s) => (
                    <tr key={s.vehicle_id}>
                      <td>{s.plate_number ?? s.vehicle_id.slice(0, 8)}</td>
                      <td>{s.incidents}</td>
                      <td className={s.open_now > 0 ? 'cell-warn' : ''}>{s.open_now}</td>
                      <td>{s.avg_minutes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ---- One-tap feedback triage queue ---- */}
          <section className="card">
            <h2>Open driver reports (one-tap feedback)</h2>
            {report.open_driver_reports.length === 0 ? (
              <div className="muted">Queue empty — nothing to triage.</div>
            ) : (
              <table className="fixes-table">
                <thead><tr><th>When</th><th>Driver</th><th>Issue</th><th>Batt %</th><th>Fix age</th><th>Network</th><th>Pending</th></tr></thead>
                <tbody>
                  {report.open_driver_reports.map((d) => (
                    <tr key={d.diag_id}>
                      <td>{new Date(d.reported_at).toLocaleString()}</td>
                      <td>{d.driver_name}</td>
                      <td><span className="chip issue">{d.issue}</span></td>
                      <td>{d.battery_pct ?? '—'}</td>
                      <td>{d.last_fix_age_s != null ? `${d.last_fix_age_s}s` : '—'}</td>
                      <td>{d.network_type ?? '—'}</td>
                      <td>{d.pending_sync_count ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="card-note">Triage via docs/PILOT-RUNBOOK.md; rows clear when marked triaged in driver_diagnostics.</div>
          </section>
        </main>
      )}
    </div>
  );
}
