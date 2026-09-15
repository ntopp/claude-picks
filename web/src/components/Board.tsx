import { Fragment, useEffect, useState } from 'react';
import { api, fmtLine, fmtTime, type League, type Slate, type SlateGame } from '../api';
import { ConfBar } from './ProposalCard';
import { useToast } from '../toast';

/** "BUF -4.5" from the home team's line; the favorite's side, PK when even. */
function spreadLabel(g: SlateGame): string {
  const l = g.lines;
  if (!l || l.spreadHome === null) return '–';
  if (l.spreadHome === 0) return 'PK';
  return l.spreadHome < 0 ? `${g.home.abbr} ${fmtLine(l.spreadHome)}` : `${g.away.abbr} ${fmtLine(-l.spreadHome)}`;
}

function team(t: SlateGame['home']) {
  return `${t.rank ? `#${t.rank} ` : ''}${t.abbr}`;
}

/** Every game this week for one league, with the engine's lean and confidence. */
export function Board({ tz, refreshKey }: { tz: string; refreshKey: number }) {
  const toast = useToast();
  const [league, setLeague] = useState<League>('nfl');
  const [data, setData] = useState<Record<League, Slate | null>>({ nfl: null, cfb: null });
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.slate('nfl'), api.slate('cfb')])
      .then(([nfl, cfb]) => {
        if (!cancelled) setData({ nfl, cfb });
      })
      .catch((e) => toast('err', (e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [toast, refreshKey]);

  const slate = data[league];
  const games = slate?.games ?? [];
  const viewed = games.filter((g) => g.view).length;

  return (
    <div className="card">
      <h2>
        This week's board
        <span className="right row">
          <span className="segmented">
            <button className={league === 'nfl' ? 'active' : ''} onClick={() => setLeague('nfl')}>
              NFL{data.nfl?.week ? ` wk ${data.nfl.week}` : ''}
            </button>
            <button className={league === 'cfb' ? 'active' : ''} onClick={() => setLeague('cfb')}>
              NCAA{data.cfb?.week ? ` wk ${data.cfb.week}` : ''}
            </button>
          </span>
        </span>
      </h2>
      {!slate ? (
        <div className="muted">Loading…</div>
      ) : games.length === 0 ? (
        <div className="empty">No games loaded for this week yet. Run the packet.</div>
      ) : (
        <>
          <div className="muted small" style={{ marginBottom: 8 }}>
            {games.length} games · engine has a read on {viewed}. Confidence under 5 means no bet; a lean is not a pick. Tap a row for the note.
          </div>
          <div className="table-wrap">
            <table className="board">
              <thead>
                <tr>
                  <th>Kickoff</th>
                  <th>Game</th>
                  <th>Spread</th>
                  <th>Total</th>
                  <th>Lean</th>
                  <th>Conf</th>
                  <th>Pick</th>
                </tr>
              </thead>
              <tbody>
                {games.map((g) => {
                  const live = g.status === 'in_progress';
                  const final = g.status === 'final';
                  const conf = g.view?.confidence ?? null;
                  return (
                    <Fragment key={g.id}>
                      <tr className={`${g.proposal ? 'has-pick' : ''} ${g.view?.note ? 'clickable' : ''}`} onClick={() => setOpen(open === g.id ? null : g.id)}>
                        <td className="muted">
                          {live ? <span className="badge live">live</span> : final ? 'Final' : fmtTime(g.kickoff, tz)}
                        </td>
                        <td>
                          {team(g.away)} {g.neutral ? 'vs' : '@'} {team(g.home)}
                          {(live || final) && g.home.score !== null && (
                            <span className="muted">
                              {' '}
                              {g.away.score}–{g.home.score}
                            </span>
                          )}
                        </td>
                        <td className="mono">{spreadLabel(g)}</td>
                        <td className="mono">{g.lines?.total ?? '–'}</td>
                        <td>{g.view ? g.view.lean : <span className="muted">–</span>}</td>
                        <td>
                          {conf !== null ? (
                            <span className="row" style={{ gap: 6 }}>
                              <ConfBar n={conf} /> <span className="muted small">{conf}</span>
                            </span>
                          ) : (
                            <span className="muted">–</span>
                          )}
                        </td>
                        <td>
                          {g.proposal ? (
                            <>
                              <span className={`badge ${g.proposal.result ?? g.proposal.status}`}>{g.proposal.result ?? g.proposal.status}</span>{' '}
                              <span className="small">{g.proposal.pick}</span>
                            </>
                          ) : (
                            ''
                          )}
                        </td>
                      </tr>
                      {open === g.id && g.view?.note && (
                        <tr className="note-row">
                          <td colSpan={7} className="wrap muted">
                            {g.view.note}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
