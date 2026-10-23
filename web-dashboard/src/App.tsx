import { useState } from 'react';
import DashboardPage from './pages/DashboardPage';
import RawFixesPage from './pages/RawFixesPage';
import ZonesPage from './pages/ZonesPage';
import PilotPage from './pages/PilotPage';

type View = 'fleet' | 'fixes' | 'zones' | 'pilot';

/** Phase 1: minimal hash-free view switch (code-split later if routes grow, §1.9.2). */
export default function App() {
  const [view, setView] = useState<View>('fixes');
  return (
    <>
      <nav className="view-nav">
        <button className={view === 'fixes' ? 'active' : ''} onClick={() => setView('fixes')}>
          Raw fixes
        </button>
        <button className={view === 'zones' ? 'active' : ''} onClick={() => setView('zones')}>
          Zones & ETA
        </button>
        <button className={view === 'fleet' ? 'active' : ''} onClick={() => setView('fleet')}>
          Fleet map
        </button>
        <button className={view === 'pilot' ? 'active' : ''} onClick={() => setView('pilot')}>
          Pilot
        </button>
      </nav>
      {view === 'fixes' ? <RawFixesPage /> : view === 'zones' ? <ZonesPage /> : view === 'pilot' ? <PilotPage /> : <DashboardPage />}
    </>
  );
}
