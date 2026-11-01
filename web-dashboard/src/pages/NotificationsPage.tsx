import { useCallback, useEffect, useState } from 'react';
import { getNotificationLog, type NotificationLogRow } from '../lib/api';

/**
 * Phase 5 audit follow-up — notification delivery ledger.
 * GET /notifications/log (FLEET_MANAGER/ADMIN; server scopes FLEET_MANAGER to
 * its own fleet's target drivers and audits every read). Before this screen
 * existed, the API binding was dead code and managers had no way to see
 * whether separation/geofence alerts actually reached drivers' phones.
 */

const EVENT_TYPES = ['TRIP_STARTED', 'TRIP_ENDED', 'DRIVER_SEPARATION_TIMER', 'GEOFENCE_ENTER', 'GEOFENCE_EXIT'] as const;
const STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;

function statusTone(status: string): string {
  if (status === 'SENT') return 'badge-ok';
  if (status === 'FAILED') return 'badge-err';
  if (status === 'SKIPPED') return 'badge-warn';
  return 'badge-pending';
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function NotificationsPage() {
  const [eventType, setEventType] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [rows, setRows] = useState<NotificationLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getNotificationLog({
        eventType: eventType || undefined,
        status: status || undefined,
        limit: 200,
      });
      setRows(r.notifications);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [eventType, status]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Notifications</h1>
        <p className="page-sub">
          Delivery ledger for driver alerts (separation timers, geofence entries/exits, trip events).
          Every read of this ledger is itself audit-logged server-side.
        </p>
      </header>

      <div className="toolbar" role="group" aria-label="Notification filters">
        <select value={eventType} onChange={(e) => setEventType(e.target.value)} aria-label="Event type">
          <option value="">All events</option>
          {EVENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Delivery status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn small" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="banner err" role="alert">{error}</div>}

      <table className="data-table">
        <thead>
          <tr>
            <th>Created</th><th>Event</th><th>Recipient</th><th>Channel</th>
            <th>Status</th><th>Sent</th><th>Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.notification_id}>
              <td>{fmtTime(n.created_at)}</td>
              <td>{n.event_type.replace(/_/g, ' ')}</td>
              <td>
                {n.recipient_role.replace('_', ' ')}
                <div className="muted small">{n.target_user?.slice(0, 8) ?? n.recipient_id.slice(0, 8)}</div>
              </td>
              <td>{n.channel}</td>
              <td><span className={`badge ${statusTone(n.status)}`}>{n.status}</span></td>
              <td>{fmtTime(n.sent_at)}</td>
              <td className="muted small">{n.error_code ?? '—'}</td>
            </tr>
          ))}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={7} className="muted center">
              No notifications match this filter — alerts appear here as they are queued and delivered.
            </td></tr>
          )}
        </tbody>
      </table>
      {loading && rows.length === 0 && <div className="muted center">Loading ledger…</div>}
    </div>
  );
}
