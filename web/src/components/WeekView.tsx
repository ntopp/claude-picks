import { useCallback, useEffect, useState } from 'react';
import { api, type Settings, type WeekData } from '../api';
import { Board } from './Board';
import { DecidedRow } from './DecidedRow';
import { ProposalCard } from './ProposalCard';
import { useToast } from '../toast';

/** Everything for one experiment week: proposed picks, open bets, passes, settled, and the board. */
export function WeekView({ weekKey, tz, settings, anthropicConfigured, onChanged, refreshKey }: { weekKey: string; tz: string; settings: Settings; anthropicConfigured: boolean; onChanged: () => void; refreshKey: number }) {
  const toast = useToast();
  const [data, setData] = useState<WeekData | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.week(weekKey));
    } catch (e) {
      toast('err', (e as Error).message);
    }
  }, [weekKey, toast]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  const changed = () => {
    load();
    onChanged();
  };

  if (!data) return <div className="muted">Loading…</div>;
  const decided = (rows: WeekData['open']) => (
    <div className="table-wrap">
      <table className="decided">
        <tbody>
          {rows.map((p) => (
            <DecidedRow key={p.id} p={p} tz={tz} maxUnits={settings.maxUnitsPerBet} onChanged={changed} />
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="grid">
      <div className="card">
        <h2>Proposed picks</h2>
        {data.pending.length === 0 ? (
          <div className="empty">
            {data.tab.current
              ? `No pending picks. ${anthropicConfigured ? 'Run a scan from the Runs tab, or from' : 'From'} a Claude Code session, run npm run packet, reason with the playbook, then npm run propose.`
              : 'Nothing pending for this week.'}
          </div>
        ) : (
          <div className="grid">
            {data.pending.map((p) => (
              <ProposalCard key={p.id} p={p} tz={tz} maxUnits={settings.maxUnitsPerBet} onChanged={changed} />
            ))}
          </div>
        )}
      </div>

      {data.open.length > 0 && (
        <div className="card">
          <h2>
            Your open bets ({data.open.length}) <span className="right muted small">tap a row for the full write-up</span>
          </h2>
          {decided(data.open)}
        </div>
      )}

      {data.passed.length > 0 && (
        <div className="card">
          <h2>
            Passed ({data.passed.length}) <span className="right muted small">still graded for the engine</span>
          </h2>
          {decided(data.passed)}
        </div>
      )}

      {data.settled.length > 0 && (
        <div className="card">
          <h2>
            Settled ({data.settled.length}) <span className="right muted small">every proposal is graded, executed or not</span>
          </h2>
          {decided(data.settled)}
        </div>
      )}

      <Board slates={data.slates} tz={tz} maxUnits={settings.maxUnitsPerBet} defaultUnits={settings.defaultUnits} onChanged={changed} />
    </div>
  );
}
