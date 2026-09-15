import { useEffect, useMemo, useState } from 'react';
import { api, fmtTime, fmtUnits, signClass, type Proposal } from '../api';
import { ProposalCard } from '../components/ProposalCard';
import { useToast } from '../toast';

type Filter = 'all' | 'executed' | 'passed' | 'expired' | 'pending';

export function Results({ tz }: { tz: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<Proposal[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [league, setLeague] = useState<'all' | 'nfl' | 'cfb'>('all');
  const [open, setOpen] = useState<number | null>(null);

  const load = async () => {
    try {
      setRows(await api.proposals());
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    if (!rows) return [];
    return rows
      .filter((p) => (filter === 'all' ? true : p.status === filter))
      .filter((p) => (league === 'all' ? true : p.league === league))
      .sort((a, b) => b.kickoff.localeCompare(a.kickoff));
  }, [rows, filter, league]);

  if (!rows) return <div className="muted">Loading…</div>;
  const opened = shown.find((p) => p.id === open);

  return (
    <div className="grid">
      <div className="card">
        <h2>
          All picks ({shown.length})
          <span className="right row">
            <select value={league} onChange={(e) => setLeague(e.target.value as typeof league)}>
              <option value="all">Both leagues</option>
              <option value="nfl">NFL</option>
              <option value="cfb">College</option>
            </select>
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">All statuses</option>
              <option value="executed">Executed</option>
              <option value="passed">Passed</option>
              <option value="expired">Expired (never decided)</option>
              <option value="pending">Pending</option>
            </select>
          </span>
        </h2>
        {shown.length === 0 ? (
          <div className="empty">Nothing here yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kickoff</th>
                  <th>Game</th>
                  <th>Pick</th>
                  <th className="num">Conf</th>
                  <th>Edge</th>
                  <th>You</th>
                  <th>Final</th>
                  <th>Result</th>
                  <th className="num">Net</th>
                  <th className="num">CLV</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} onClick={() => setOpen(open === p.id ? null : p.id)} style={{ cursor: 'pointer', background: open === p.id ? 'var(--bg-3)' : undefined }}>
                    <td className="muted">{fmtTime(p.kickoff, tz)}</td>
                    <td>
                      <span className={`badge ${p.league}`}>{p.league}</span> {p.matchup}
                    </td>
                    <td>{p.pick}</td>
                    <td className="num">{p.confidence}</td>
                    <td className="muted">{p.edge_type.replace('_', ' ')}</td>
                    <td>
                      <span className={`badge ${p.status}`}>{p.status}</span>
                      {p.status === 'executed' && p.executed_units !== null ? <span className="muted small"> {p.executed_units}u</span> : ''}
                    </td>
                    <td className="muted">
                      {p.game && p.game.home_score !== null ? `${p.game.away_abbr} ${p.game.away_score} – ${p.game.home_score} ${p.game.home_abbr}` : p.game?.status === 'in_progress' ? 'live' : ''}
                    </td>
                    <td>{p.result ? <span className={`badge ${p.result}`}>{p.result}</span> : ''}</td>
                    <td className={`num ${signClass(p.units_net)}`}>{p.units_net === null ? '' : fmtUnits(p.units_net)}</td>
                    <td className={`num ${signClass(p.clv)}`}>{p.clv === null ? '' : `${p.clv > 0 ? '+' : ''}${p.clv.toFixed(1)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {opened && (
        <div className="card">
          <h2>
            Pick #{opened.id}
            <span className="right">
              <button className="btn sm" onClick={() => setOpen(null)}>
                close
              </button>
            </span>
          </h2>
          <ProposalCard p={opened} tz={tz} maxUnits={5} onChanged={load} />
        </div>
      )}
    </div>
  );
}
