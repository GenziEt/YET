import { Suspense, lazy, useEffect, useState } from 'react';
import { getHealth, type HealthResponse } from '../lib/api';

// §1.9.2: Leaflet is lazy-loaded so initial JS stays small on 3G.
const FleetMap = lazy(() => import('../components/FleetMap'));

export default function DashboardPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());

  useEffect(() => {
    const t = setInterval(() => {
      getHealth().then((h) => { setHealth(h); setLastUpdated(Date.now()); }).catch(() => {});
    }, 30_000);
    getHealth().then(setHealth).catch(() => {});
    return () => clearInterval(t);
  }, []);

  // §1.8.4: staleness banner instead of infinite spinners when data goes stale.
  const staleMin = Math.floor((Date.now() - lastUpdated) / 60_000);
  return (
    <div className="page">
      <header>
        <h1>Fleet Dashboard</h1>
        <span className={`pill ${health?.db === 'ok' ? 'ok' : 'bad'}`} role="status">
          backend {health ? `${health.version} · db:${health.db}` : 'offline'}
        </span>
        {staleMin > 2 && <span className="pill warn">last updated {staleMin} min ago</span>}
      </header>
      <main className="map-wrap">
        <Suspense fallback={<div className="map-loading">Loading map…</div>}>
          <FleetMap />
        </Suspense>
      </main>
      <footer>Phase 0 — foundation build. Trip data arrives in Phase 1.</footer>
    </div>
  );
}
