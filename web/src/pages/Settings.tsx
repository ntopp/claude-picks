import { useEffect, useState } from 'react';
import { api, type Settings } from '../api';
import { useToast } from '../toast';

const FIELDS: { key: keyof Settings; label: string; help: string; step?: number }[] = [
  { key: 'unitDollars', label: 'Dollars per unit (display only)', help: 'What 1u would be if this were real money.' },
  { key: 'bankrollUnits', label: 'Starting bankroll (units)', help: 'The scoreboard adds your net units to this.' },
  { key: 'defaultUnits', label: 'Default stake (units)', help: 'What an ordinary pick is sized at.', step: 0.5 },
  { key: 'maxUnitsPerBet', label: 'Max units per bet', help: 'Caps both the engine and the Execute box.', step: 0.5 },
  { key: 'maxPicksPerWeek', label: 'Max picks per week', help: 'Across both leagues; lowest-confidence extras are dropped.' },
  { key: 'minConfidence', label: 'Minimum confidence', help: 'Proposals under this are dropped at insert (1-10).' },
  { key: 'lineTolerance', label: 'Line tolerance (points)', help: 'A proposal whose number differs from the current line by more than this is dropped as stale.', step: 0.5 },
  { key: 'maxFavoritePrice', label: 'Shortest moneyline favorite', help: 'e.g. -250: favorites shorter than this are dropped.' },
];

export function SettingsPage({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings().then(setS).catch((e) => toast('err', (e as Error).message));
  }, [toast]);

  if (!s) return <div className="muted">Loading…</div>;

  const save = async () => {
    setBusy(true);
    try {
      setS(await api.saveSettings(s));
      toast('ok', 'Settings saved');
      onSaved();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid">
      <div className="card">
        <h2>Bankroll rails</h2>
        <div className="form">
          {FIELDS.map((f) => (
            <label key={f.key}>
              {f.label}
              <input type="number" step={f.step ?? 1} value={s[f.key] as number} onChange={(e) => setS({ ...s, [f.key]: Number(e.target.value) })} />
              <span className="muted">{f.help}</span>
            </label>
          ))}
          <label className="row full">
            <input type="checkbox" checked={s.webSearch} onChange={(e) => setS({ ...s, webSearch: e.target.checked })} />
            Let the API engine research with web search (injuries, weather, coaching news). Costs more per scan; the session engine researches on its own.
          </label>
          <label className="row full">
            <input type="checkbox" checked={s.autoScan} onChange={(e) => setS({ ...s, autoScan: e.target.checked })} />
            Run the API scan automatically every Wednesday at 10:00 (needs ANTHROPIC_API_KEY).
          </label>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={busy} onClick={save}>
            Save
          </button>
        </div>
      </div>
      <div className="card">
        <h2>How grading works</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Every 30 minutes the server refreshes any week with an open pick. The last line seen before kickoff is frozen as the closing line. When a game goes final, every proposal on it is settled — executed, passed, or expired — so the engine is scored on all of its ideas and you are scored only on what you took. CLV (closing line value) is how many points better your number was than the close; sustained positive CLV is the best early evidence of real edge, long before win rate is statistically meaningful.
        </p>
      </div>
    </div>
  );
}
