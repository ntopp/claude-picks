import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, fmtPct, fmtUnits, signClass, type Dashboard as DashboardData, type Status } from '../api';
import { ProposalCard } from '../components/ProposalCard';
import { DecidedRow } from '../components/DecidedRow';
import { Board } from '../components/Board';
import { useToast } from '../toast';

export function Dashboard({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<DashboardData | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await api.dashboard());
    } catch (e) {
      toast('err', (e as Error).message);
    }
  }, [toast]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const changed = () => {
    load();
    onChanged();
    setRefreshKey((k) => k + 1);
  };

  const grade = async () => {
    setBusy(true);
    try {
      const r = await api.grade();
      toast('ok', `Refreshed ${r.refreshed} game(s), graded ${r.graded}`);
      changed();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="muted">Loading…</div>;
  const { engine, human, bankroll, breakEven, unitDollars } = data.scoreboard;
  const tz = status.displayTz;

  return (
    <div className="grid">
      <div className="grid cols-4">
        <div className="card stat">
          <span className="label">Bankroll</span>
          <span className="value">{bankroll.now}u</span>
          <span className="sub">
            {fmtMoney(bankroll.now, unitDollars)} · started {bankroll.start}u{bankroll.drawdown > 0 ? ` · ${bankroll.drawdown}u off peak` : ''}
          </span>
        </div>
        <div className="card stat">
          <span className="label">Your record</span>
          <span className="value">
            {human.wins}-{human.losses}
            {human.pushes ? `-${human.pushes}` : ''}
          </span>
          <span className="sub">
            {fmtPct(human.winRate)} win · <span className={signClass(human.net)}>{fmtUnits(human.net)}</span> · ROI {fmtPct(human.roi)}
          </span>
        </div>
        <div className="card stat">
          <span className="label">Engine (all picks)</span>
          <span className="value">
            {engine.wins}-{engine.losses}
            {engine.pushes ? `-${engine.pushes}` : ''}
          </span>
          <span className="sub">
            {fmtPct(engine.winRate)} win · <span className={signClass(engine.net)}>{fmtUnits(engine.net)}</span> · need {fmtPct(breakEven)}
          </span>
        </div>
        <div className="card stat">
          <span className="label">Closing line value</span>
          <span className={`value ${signClass(engine.avgClv)}`}>{engine.avgClv === null ? '–' : `${engine.avgClv > 0 ? '+' : ''}${engine.avgClv.toFixed(2)}`}</span>
          <span className="sub">avg pts vs close · beat close {fmtPct(engine.clvBeatRate)}</span>
        </div>
      </div>

      <div className="card">
        <h2>
          Proposed picks
          <span className="right row">
            <button className="btn sm" disabled={busy} onClick={grade}>
              Refresh scores &amp; grade
            </button>
          </span>
        </h2>
        {data.pending.length === 0 ? (
          <div className="empty">
            No pending picks. {status.anthropicConfigured ? 'Run a scan from the Runs tab, or' : 'From a Claude Code session,'} run <code>npm run packet</code>, reason with the playbook, then <code>npm run propose</code>.
          </div>
        ) : (
          <div className="grid">
            {data.pending.map((p) => (
              <ProposalCard key={p.id} p={p} tz={tz} maxUnits={data.settings.maxUnitsPerBet} onChanged={changed} />
            ))}
          </div>
        )}
      </div>

      {data.live.length > 0 && (
        <div className="card">
          <h2>
            Your open bets ({data.live.length}) <span className="right muted small">tap a row for the full write-up</span>
          </h2>
          <div className="table-wrap">
            <table className="decided">
              <tbody>
                {data.live.map((p) => (
                  <DecidedRow key={p.id} p={p} tz={tz} maxUnits={data.settings.maxUnitsPerBet} onChanged={changed} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.passed.length > 0 && (
        <div className="card">
          <h2>
            Passed this week ({data.passed.length}) <span className="right muted small">still graded for the engine</span>
          </h2>
          <div className="table-wrap">
            <table className="decided">
              <tbody>
                {data.passed.map((p) => (
                  <DecidedRow key={p.id} p={p} tz={tz} maxUnits={data.settings.maxUnitsPerBet} onChanged={changed} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Board tz={tz} refreshKey={refreshKey} />

      {data.recent.length > 0 && (
        <div className="card">
          <h2>
            Recently settled <span className="right muted small">every proposal is graded, executed or not</span>
          </h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Pick</th>
                  <th>Final</th>
                  <th>Result</th>
                  <th className="num">Net</th>
                  <th className="num">CLV</th>
                  <th>You</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className={`badge ${p.league}`}>{p.league}</span> {p.matchup}
                    </td>
                    <td>{p.pick}</td>
                    <td className="muted">{p.game ? `${p.game.away_abbr} ${p.game.away_score} – ${p.game.home_score} ${p.game.home_abbr}` : ''}</td>
                    <td>
                      <span className={`badge ${p.result}`}>{p.result}</span>
                    </td>
                    <td className={`num ${signClass(p.units_net)}`}>{fmtUnits(p.units_net)}</td>
                    <td className={`num ${signClass(p.clv)}`}>{p.clv === null ? '–' : `${p.clv > 0 ? '+' : ''}${p.clv.toFixed(1)}`}</td>
                    <td>
                      <span className={`badge ${p.status}`}>{p.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
