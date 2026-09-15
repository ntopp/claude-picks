import { useState } from 'react';
import { api, fmtLine, fmtPrice, fmtTime, fmtUnits, leagueLabel, signClass, type Proposal } from '../api';
import { useToast } from '../toast';

export function ConfBar({ n }: { n: number }) {
  return (
    <span className="confbar" title={`confidence ${n}/10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <i key={i} className={i < n ? 'on' : ''} />
      ))}
    </span>
  );
}

/** How the line has moved since the pick was made, from the picked side's point of view. */
function LineMove({ p }: { p: Proposal }) {
  if (p.market === 'moneyline') {
    if (p.currentPrice === null || p.currentPrice === p.price) return null;
    const better = p.currentPrice > p.price; // longer odds now = we'd get more now = market moved against our side
    return (
      <span className={`linemove ${better ? 'neg' : 'pos'}`}>
        now {fmtPrice(p.currentPrice)} {better ? '(market moved against)' : '(market moved with us)'}
      </span>
    );
  }
  if (p.currentLine === null || p.line === null || p.currentLine === p.line) return null;
  // Spread: higher number for our side is better. Over: lower is better. Under: higher is better.
  const diff = p.side === 'over' ? p.line - p.currentLine : p.currentLine - p.line;
  const withUs = diff < 0; // the number moved toward our side (we have the better of it)
  return (
    <span className={`linemove ${withUs ? 'pos' : 'neg'}`}>
      now {p.market === 'total' ? p.currentLine : fmtLine(p.currentLine)} {withUs ? '(we beat the move)' : '(better number available now)'}
    </span>
  );
}

export function ProposalCard({ p, tz, maxUnits, onChanged, readOnly }: { p: Proposal; tz: string; maxUnits: number; onChanged: () => void; readOnly?: boolean }) {
  const toast = useToast();
  const [units, setUnits] = useState<number>(p.units);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const kickedOff = new Date(p.kickoff).getTime() < Date.now();

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast('ok', ok);
      onChanged();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <div className="proposal">
      <div className="head">
        <span className={`badge ${p.league}`}>{leagueLabel(p.league)}</span>
        <span className={`badge ${p.market}`}>{p.market}</span>
        <span className="pick">{p.pick}</span>
        <span className="muted">{p.matchup}</span>
        {p.status !== 'pending' && <span className={`badge ${p.status}`}>{p.status}</span>}
        {p.result && <span className={`badge ${p.result}`}>{p.result}</span>}
        <span className="conf">
          <ConfBar n={p.confidence} /> {p.confidence}/10
        </span>
      </div>
      <div className="meta">
        <span>
          <b>{fmtTime(p.kickoff, tz)}</b>
        </span>
        <span>
          stake <b>{p.units}u</b>
          {p.executed_units !== null && p.executed_units !== p.units ? ` (you: ${p.executed_units}u)` : ''}
        </span>
        <span>
          edge <b>{p.edge_type.replace('_', ' ')}</b>
        </span>
        <LineMove p={p} />
        {p.game && (p.game.status === 'in_progress' || p.game.status === 'final') && (
          <span>
            {p.game.status === 'in_progress' ? <span className="badge live">live</span> : 'final'} <b>{p.game.away_abbr} {p.game.away_score ?? '–'} – {p.game.home_score ?? '–'} {p.game.home_abbr}</b>
          </span>
        )}
        {p.units_net !== null && (
          <span>
            net <b className={signClass(p.units_net)}>{fmtUnits(p.units_net)}</b>
          </span>
        )}
        {p.clv !== null && (
          <span title="closing line value: how much better our number was than the close">
            CLV <b className={signClass(p.clv)}>{p.clv > 0 ? '+' : ''}{p.clv.toFixed(1)}</b>
          </span>
        )}
      </div>
      <div className="thesis">{p.thesis}</div>
      {p.key_factors.length > 0 && (
        <details>
          <summary>Key factors ({p.key_factors.length})</summary>
          <ul>
            {p.key_factors.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="bear">
        <b>Bear case:</b> {p.bear_case}
      </div>
      {p.decision_note && (
        <div className="muted small">
          Your note: {p.decision_note}
        </div>
      )}
      {!readOnly && p.status === 'pending' && (
        <div className="actions">
          {kickedOff ? (
            <span className="muted">Kicked off — this pick expires and will be graded for the engine only.</span>
          ) : !confirm ? (
            <>
              <label className="muted small">
                units{' '}
                <input type="number" min={0.5} max={maxUnits} step={0.5} value={units} onChange={(e) => setUnits(Number(e.target.value))} />
              </label>
              <input type="text" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn execute" disabled={busy} onClick={() => setConfirm(true)}>
                Execute
              </button>
              <button className="btn" disabled={busy} onClick={() => act(() => api.pass(p.id, note || undefined), `Passed on ${p.pick}`)}>
                Pass
              </button>
            </>
          ) : (
            <>
              <span>
                Log <b>{units}u</b> on <b>{p.pick}</b>?
              </span>
              <button className="btn execute" disabled={busy} onClick={() => act(() => api.execute(p.id, units, note || undefined), `Executed ${p.pick} for ${units}u`)}>
                Confirm
              </button>
              <button className="btn" disabled={busy} onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
      {!readOnly && (p.status === 'executed' || p.status === 'passed') && !kickedOff && (
        <div className="actions">
          <button className="btn sm" disabled={busy} onClick={() => act(() => api.undo(p.id), 'Back to pending')}>
            Undo {p.status === 'executed' ? 'execute' : 'pass'}
          </button>
        </div>
      )}
    </div>
  );
}
