import { useEffect, useState } from 'react';
import DashboardPage from './pages/DashboardPage';
import RawFixesPage from './pages/RawFixesPage';
import ZonesPage from './pages/ZonesPage';
import PilotPage from './pages/PilotPage';
import ReportsPage from './pages/ReportsPage';

type View = 'fleet' | 'fixes' | 'zones' | 'pilot' | 'reports';

const VIEWS: { id: View; label: string; icon: JSX.Element }[] = [
  {
    id: 'fixes',
    label: 'Raw fixes',
    icon: (
      <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 17l4-8 4 5 3-6 4 7" /><circle cx="7" cy="9" r="1.4" /><circle cx="14" cy="8" r="1.4" />
      </svg>
    ),
  },
  {
    id: 'zones',
    label: 'Zones & ETA',
    icon: (
      <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 21s-6-5.2-6-10a6 6 0 1112 0c0 4.8-6 10-6 10z" /><circle cx="12" cy="11" r="2.2" />
      </svg>
    ),
  },
  {
    id: 'fleet',
    label: 'Fleet map',
    icon: (
      <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" /><path d="M9 4v14M15 6v14" />
      </svg>
    ),
  },
  {
    id: 'pilot',
    label: 'Pilot',
    icon: (
      <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" />
        <rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" />
      </svg>
    ),
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: (
      <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" />
      </svg>
    ),
  },
];

/**
 * Phase 1: minimal hash-free view switch (code-split later if routes grow, §1.9.2).
 * v2: professional app shell — sidebar navigation with off-canvas drawer on
 * small screens, skip link for keyboard users, aria-current on active tab.
 */
export default function App() {
  const [view, setView] = useState<View>('fixes');
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer with Escape (a11y).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const go = (v: View) => { setView(v); setDrawerOpen(false); };

  return (
    <div className={`app-shell${drawerOpen ? ' drawer-open' : ''}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>

      {/* Mobile scrim — click closes the drawer */}
      {drawerOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} />}

      <nav className="sidebar" aria-label="Primary" aria-hidden={undefined}>
        <div className="sidebar-brand">
          <img className="brand-logo" src="/met-logo.svg" alt="MET" />
          <span className="wordmark"><strong>YET</strong><span>Fleet Intelligence</span></span>
        </div>
        <div className="sidebar-nav" role="tablist" aria-orientation="vertical">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              aria-current={view === v.id ? 'page' : undefined}
              className={`nav-item${view === v.id ? ' active' : ''}`}
              onClick={() => go(v.id)}
            >
              {v.icon}
              {v.label}
            </button>
          ))}
        </div>
        <div className="sidebar-foot">PDPP-compliant · reads audit-logged</div>
      </nav>

      <div className="main-col">
        <div className="topbar">
          <button
            className="hamburger"
            aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((o) => !o)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {drawerOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
        <div id="main-content" className="page-host">
          {view === 'fixes' ? <RawFixesPage /> : view === 'zones' ? <ZonesPage /> : view === 'pilot' ? <PilotPage /> : view === 'reports' ? <ReportsPage /> : <DashboardPage />}
        </div>
      </div>
    </div>
  );
}
