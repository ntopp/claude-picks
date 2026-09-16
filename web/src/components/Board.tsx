import { Fragment, useState } from 'react';
import { api, fmtLine, fmtPrice, fmtTime, type League, type Lines, type Slate, type SlateGame } from '../api';
import { ConfBar } from './ProposalCard';
import { useToast } from '../toast';

/** "BUF -4.5" from the home team's line; the favorite's side, PK when even. */
function spreadLabel(g: SlateGame): string {
  const l = g.lines;
  if (!l || l.spreadHome === null) return '–';
  if (l.spreadHome === 0) return 'PK';
  return l.spreadHome < 0 ? `${g.home.abbr} ${fmtLine(l.spreadHome)}` : `${g.away.abbr} ${fmtLine(-l.spreadHome)}`;
}

const team = (t: SlateGame['home']) => `${t.rank ? `#${t.rank} ` : ''}${t.abbr}`;

/** What the lean would be logged at right now: the picked side's current line and price. */
function leanNow(lean: string, g: SlateGame): string | null {
  const l: Lines | null = g.lines;
  if (!l) return null;
  const t = lean.trim();
  let m = /^(over|under)\s+[\d.]+$/i.exec(t);
  if (m) {
    if (l.total === null) return null;
    const over = m[1].toLowerCase() === 'over';
    return `${over ? 'Over' : 'Under'} ${l.total} (${fmtPrice(over ? l.overPrice : l.underPrice)})`;
  }
  m = /^([A-Za-z&\-'.]+)\s+(ML|[+-]?[\d.]+|PK)$/i.exec(t);
  if (!m) return null;
  const abbr = m[1].toUpperCase();
  const side = abbr === g.home.abbr.toUpperCase() ? 'home' : abbr === g.away.abbr.toUpperCase() ? 'away' : null;
  if (!side) return null;
  if (m[2].toUpperCase() === 'ML') {
    const p = side === 'home' ? l.mlHome : l.mlAway;
    return p === null ? null : `${abbr} ML ${fmtPrice(p)}`;
  }
  if (l.spreadHome === null) return null;
  const line = side === 'home' ? l.spreadHome : -l.spreadHome;
  return `${abbr} ${fmtLine(line)} (${fmtPrice(side === 'home' ? l.spreadHomePrice : l.spreadAwayPrice)})`;
}

/** One league-week board: every game with the engine's lean and confidence; tap a row for the note and to bet the lean. */
export function Board({ slates, tz, maxUnits, defaultUnits, onChanged }: { slates: { nfl: Slate | null; cfb: Slate | null }; tz: string; maxUnits: number; defaultUnits: number; onChanged: () => void }) {
  const toast = useToast();
  const [league, setLeague] = useState<League>(slates.nfl ? 'nfl' : 'cfb');
  const [open, setOpen] = useState<string | null>(null);
  const [units, setUnits] = useState<number>(defaultUnits);
  const [busy, setBusy] = useState(false);

  const slate = slates[league];
  const games = slate?.games ?? [];
  const viewed = games.filter((g) => g.view).length;

  const bet = async (g: SlateGame) => {
    setBusy(true);
    try {
      const r = await api.executeLean(g.id, units);
      toast('ok', `Executed ${r.pick} for ${units}u`);
      setOpen(null);
      onChanged();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>
        <span className="segmented">
          {slates.nfl && (
            <button className={league === 'nfl' ? 'active' : ''} onClick={() => setLeague('nfl')}>
              NFL
            </button>
          )}
          {slates.cfb && (
            <button className={league === 'cfb' ? 'active' : ''} onClick={() => setLeague('cfb')}>
              NCAA
            </button>
          )}
        </span>
        Board
        <span className="right muted small">
          {games.length} games · read on {viewed}
        </span>
      </h2>
      {!slate ? (
        <div className="empty">No {league.toUpperCase()} games in this week.</div>
      ) : games.length === 0 ? (
        <div className="empty">No games loaded for this week yet. Run the packet.</div>
      ) : (
        <>
          <div className="muted small" style={{ marginBottom: 8 }}>
            Confidence under 5 means no bet; a lean is not a pick. Tap a row for the note, or to bet the lean yourself at today's number.
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
                  const canBet = !g.proposal && g.status === 'scheduled' && new Date(g.kickoff).getTime() > Date.now() && !!g.view && g.view.lean !== 'no lean';
                  const now = g.view && canBet ? leanNow(g.view.lean, g) : null;
                  return (
                    <Fragment key={g.id}>
                      <tr className={`${g.proposal ? 'has-pick' : ''} ${g.view ? 'clickable' : ''}`} onClick={() => g.view && setOpen(open === g.id ? null : g.id)}>
                        <td className="muted">{live ? <span className="badge live">live</span> : final ? 'Final' : fmtTime(g.kickoff, tz)}</td>
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
                            <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
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
                              {g.proposal.origin === 'lean' ? <span className="muted small"> (your lean bet)</span> : ''}
                            </>
                          ) : (
                            ''
                          )}
                        </td>
                      </tr>
                      {open === g.id && g.view && (
                        <tr className="note-row">
                          <td colSpan={7} className="wrap">
                            <div className="muted">{g.view.note || 'No note.'}</div>
                            {canBet && (
                              <div className="actions lean-actions" onClick={(e) => e.stopPropagation()}>
                                <span className="small">
                                  Bet the lean at today's number: <b>{now ?? 'no current line'}</b>
                                </span>
                                <label className="muted small">
                                  units{' '}
                                  <input type="number" min={0.5} max={maxUnits} step={0.5} value={units} onChange={(e) => setUnits(Number(e.target.value))} />
                                </label>
                                <button className="btn execute sm" disabled={busy || !now} onClick={() => bet(g)}>
                                  Execute {units}u
                                </button>
                              </div>
                            )}
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
