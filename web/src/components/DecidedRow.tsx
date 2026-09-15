import { Fragment, useState } from 'react';
import { fmtLine, fmtPrice, fmtTime, leagueLabel, type Proposal } from '../api';
import { ProposalCard } from './ProposalCard';

/** Where the picked side's number is now vs what we took, compactly. */
function nowLabel(p: Proposal): { text: string; cls: string } | null {
  if (p.market === 'moneyline') {
    if (p.currentPrice === null || p.currentPrice === p.price) return null;
    return { text: `now ${fmtPrice(p.currentPrice)}`, cls: p.currentPrice > p.price ? 'neg' : 'pos' };
  }
  if (p.currentLine === null || p.line === null || p.currentLine === p.line) return null;
  const diff = p.side === 'over' ? p.line - p.currentLine : p.currentLine - p.line;
  return { text: `now ${p.market === 'total' ? p.currentLine : fmtLine(p.currentLine)}`, cls: diff < 0 ? 'pos' : 'neg' };
}

/** One line per decided pick; tap to expand the full card (thesis, bear case, undo). */
export function DecidedRow({ p, tz, maxUnits, onChanged }: { p: Proposal; tz: string; maxUnits: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const now = nowLabel(p);
  const g = p.game;
  const live = g?.status === 'in_progress';
  const final = g?.status === 'final';
  return (
    <Fragment>
      <tr className="clickable" onClick={() => setOpen(!open)}>
        <td>
          <span className={`badge ${p.league}`}>{leagueLabel(p.league)}</span>
        </td>
        <td>
          <b>{p.pick}</b> <span className="muted">{p.matchup}</span>
        </td>
        <td className="muted">{live ? <span className="badge live">live</span> : final ? 'Final' : fmtTime(p.kickoff, tz)}</td>
        <td>
          {g && (live || final) && g.home_score !== null ? (
            <b>
              {g.away_abbr} {g.away_score} – {g.home_score} {g.home_abbr}
            </b>
          ) : now ? (
            <span className={`small ${now.cls}`}>{now.text}</span>
          ) : (
            ''
          )}
        </td>
        <td>
          <span className={`badge ${p.status}`}>{p.status}</span>
          {p.status === 'executed' ? <span className="muted small"> {p.executed_units ?? p.units}u</span> : ''}
        </td>
        <td className="muted small">{p.confidence}/10</td>
      </tr>
      {open && (
        <tr className="note-row">
          <td colSpan={6} style={{ padding: '6px 0 10px' }}>
            <ProposalCard p={p} tz={tz} maxUnits={maxUnits} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
