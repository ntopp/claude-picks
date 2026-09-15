import { useCallback, useEffect, useState } from 'react';
import { api, type Status } from './api';
import { Dashboard } from './pages/Dashboard';
import { Results } from './pages/Results';
import { ScoreboardPage } from './pages/Scoreboard';
import { Runs } from './pages/Runs';
import { SettingsPage } from './pages/Settings';
import { ToastProvider } from './toast';

type Tab = 'dashboard' | 'results' | 'scoreboard' | 'runs' | 'settings';
const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Picks' },
  { id: 'results', label: 'Results' },
  { id: 'scoreboard', label: 'Scoreboard' },
  { id: 'runs', label: 'Runs' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 60_000);
    return () => clearInterval(t);
  }, [loadStatus]);

  if (error && !status) {
    return (
      <div className="setup card">
        <h2>Server not reachable</h2>
        <p>
          Start the backend with <code>npm run dev:server</code> in the project folder. Error: <span className="neg">{error}</span>
        </p>
      </div>
    );
  }
  if (!status) return <div className="page muted">Loading…</div>;

  const weeks = (['nfl', 'cfb'] as const)
    .map((l) => (status.upcoming[l] ? `${l.toUpperCase()} wk ${status.upcoming[l]!.week}` : null))
    .filter(Boolean)
    .join(' · ');

  return (
    <ToastProvider>
      <header className="topbar">
        <span className="brand">Claude Picks</span>
        <span className="badge paper">Paper</span>
        {weeks && <span className="muted small">{weeks}</span>}
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'dashboard' && status.pending > 0 ? ` (${status.pending})` : ''}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="muted small">
          Engine: {status.anthropicConfigured ? `API (${status.model})` : 'Claude Code session'} · {status.notifications ? 'push on' : 'push off'} · {status.displayTz}
        </span>
      </header>
      <main className="page">
        {tab === 'dashboard' && <Dashboard status={status} onChanged={loadStatus} />}
        {tab === 'results' && <Results tz={status.displayTz} />}
        {tab === 'scoreboard' && <ScoreboardPage />}
        {tab === 'runs' && <Runs status={status} onChanged={loadStatus} />}
        {tab === 'settings' && <SettingsPage onSaved={loadStatus} />}
      </main>
    </ToastProvider>
  );
}
