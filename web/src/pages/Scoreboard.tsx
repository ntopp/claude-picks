import { useEffect, useState } from 'react';
import { api, fmtMoney, fmtPct, fmtSignedPct, fmtUnits, signClass, type Bucket, type Lesson, type ReviewRow, type Scoreboard } from '../api';
import { UnitsChart } from '../components/UnitsChart';
import { useToast } from '../toast';

function WinRate({ b, breakEven }: { b: Bucket; breakEven: number }) {
  const r = b.winRate ?? 0;
  return (
    <div className="winrate">
      <div className="bar">
        <div className="fill" style={{ width: `${Math.min(100, r * 100)}%`, background: b.winRate === null ? 'var(--border)' : r >= breakEven ? 'var(--pos)' : 'var(--neg)' }} />
        <div className="be" style={{ left: `${breakEven * 100}%` }} title={`break-even ${fmtPct(breakEven)}`} />
      </div>
      <span className="mono small">{fmtPct(b.winRate)}</span>
    </div>
  );
}

function BucketTable({ title, rows, breakEven }: { title: string; rows: [string, Bucket][]; breakEven: number }) {
  if (rows.length === 0) return null;
  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>W-L-P</th>
              <th style={{ minWidth: 160 }}>Win % (line = break-even)</th>
              <th className="num">Units</th>
              <th className="num">ROI</th>
              <th className="num">Avg CLV</th>
              <th className="num">Beat close</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, b]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>
                  {b.wins}-{b.losses}-{b.pushes}
                </td>
                <td>
                  <WinRate b={b} breakEven={breakEven} />
                </td>
                <td className={`num ${signClass(b.net)}`}>{fmtUnits(b.net)}</td>
                <td className={`num ${signClass(b.roi)}`}>{fmtSignedPct(b.roi)}</td>
                <td className={`num ${signClass(b.avgClv)}`}>{b.avgClv === null ? '–' : `${b.avgClv > 0 ? '+' : ''}${b.avgClv.toFixed(2)}`}</td>
                <td className="num">{fmtPct(b.clvBeatRate, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ScoreboardPage() {
  const toast = useToast();
  const [sb, setSb] = useState<Scoreboard | null>(null);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [s, r, l] = await Promise.all([api.scoreboard(), api.reviews(), api.lessons()]);
      setSb(s);
      setReviews(r);
      setLessons(l);
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runReview = async () => {
    setBusy(true);
    try {
      await api.runReview();
      toast('ok', 'Review written');
      load();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!sb) return <div className="muted">Loading…</div>;
  const be = sb.breakEven;
  const label = (k: string) => ({ nfl: 'NFL', cfb: 'College', spread: 'Spread', total: 'Total', moneyline: 'Moneyline' })[k] ?? k.replace('_', ' ');

  return (
    <div className="grid">
      <div className="grid cols-4">
        <div className="card stat">
          <span className="label">Engine win rate</span>
          <span className={`value ${sb.engine.winRate === null ? '' : sb.engine.winRate >= be ? 'pos' : 'neg'}`}>{fmtPct(sb.engine.winRate)}</span>
          <span className="sub">
            {sb.engine.n} settled · need {fmtPct(be)} at -110
          </span>
        </div>
        <div className="card stat">
          <span className="label">Engine units</span>
          <span className={`value ${signClass(sb.engine.net)}`}>{fmtUnits(sb.engine.net)}</span>
          <span className="sub">ROI {fmtSignedPct(sb.engine.roi)} on {sb.engine.staked.toFixed(1)}u staked</span>
        </div>
        <div className="card stat">
          <span className="label">Your bankroll</span>
          <span className={`value ${signClass(sb.bankroll.now - sb.bankroll.start)}`}>{sb.bankroll.now}u</span>
          <span className="sub">
            {fmtMoney(sb.bankroll.now, sb.unitDollars)} · {sb.human.wins}-{sb.human.losses}-{sb.human.pushes} · ROI {fmtSignedPct(sb.human.roi)}
          </span>
        </div>
        <div className="card stat">
          <span className="label">Beat the close</span>
          <span className={`value ${signClass(sb.engine.avgClv)}`}>{fmtPct(sb.engine.clvBeatRate, 0)}</span>
          <span className="sub">avg CLV {sb.engine.avgClv === null ? '–' : `${sb.engine.avgClv > 0 ? '+' : ''}${sb.engine.avgClv.toFixed(2)} pts`}</span>
        </div>
      </div>

      <div className="card">
        <h2>
          Cumulative units <span className="right muted small">{sb.pending} pending</span>
        </h2>
        <UnitsChart series={sb.series} />
      </div>

      <div className="card">
        <h2>Your filter vs the engine</h2>
        <p style={{ margin: 0 }}>{sb.humanEdge.verdict}</p>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          Executed ROI {fmtSignedPct(sb.humanEdge.executedRoi)} · Passed ROI {fmtSignedPct(sb.humanEdge.passedRoi)} ({sb.passed.n} passed picks graded as if bet at the proposed stake)
          {sb.leanBets.n > 0 && (
            <>
              {' '}· Board leans you bet yourself: {sb.leanBets.wins}-{sb.leanBets.losses}-{sb.leanBets.pushes}, {fmtUnits(sb.leanBets.net)} (ROI {fmtSignedPct(sb.leanBets.roi)}) — not counted against the engine.
            </>
          )}
        </p>
      </div>

      <div className="grid cols-2">
        <BucketTable
          title="Board leans by confidence (every read, graded as 1u at its own line)"
          rows={[['All leans', sb.leans.all] as [string, Bucket], ...sb.leans.byConfidence.map((b) => [b.label, b.bucket] as [string, Bucket]), ['Leans at 5+ that were not picks', sb.leans.wouldBePicks] as [string, Bucket]]}
          breakEven={be}
        />
        <BucketTable title="Baselines (dumb rules on every final game at the close)" rows={Object.entries(sb.baselines)} breakEven={be} />
        <BucketTable title="Leans by league" rows={Object.entries(sb.leans.byLeague).map(([k, b]) => [label(k), b])} breakEven={be} />
        <BucketTable title="Leans by market" rows={Object.entries(sb.leans.byMarket).map(([k, b]) => [label(k), b])} breakEven={be} />
      </div>

      <div className="card">
        <h2>Engine picks: how they compare</h2>
        <p className="muted small" style={{ margin: 0 }}>
          The leans table is the calibration check: if the engine's reads mean anything, the 5s and 6s should win more often than the 3s. The baselines are what a rule with no research would have done on the same games — the picks need to beat those, not just 52.4%.
        </p>
      </div>

      <div className="grid cols-2">
        <BucketTable title="By league" rows={Object.entries(sb.byLeague).map(([k, b]) => [label(k), b])} breakEven={be} />
        <BucketTable title="By market" rows={Object.entries(sb.byMarket).map(([k, b]) => [label(k), b])} breakEven={be} />
        <BucketTable title="By edge type" rows={Object.entries(sb.byEdge).map(([k, b]) => [label(k), b])} breakEven={be} />
        <BucketTable title="By confidence (calibration)" rows={Object.entries(sb.byConfidence).map(([k, b]) => [`conf ${k}`, b])} breakEven={be} />
      </div>

      {sb.byWeek.length > 0 && (
        <div className="card">
          <h2>By week</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Engine</th>
                  <th className="num">Units</th>
                  <th>You</th>
                  <th className="num">Units</th>
                </tr>
              </thead>
              <tbody>
                {sb.byWeek.map((w) => (
                  <tr key={w.key}>
                    <td>{w.label}</td>
                    <td>
                      {w.engine.wins}-{w.engine.losses}-{w.engine.pushes} ({fmtPct(w.engine.winRate, 0)})
                    </td>
                    <td className={`num ${signClass(w.engine.net)}`}>{fmtUnits(w.engine.net)}</td>
                    <td>
                      {w.human.n ? `${w.human.wins}-${w.human.losses}-${w.human.pushes} (${fmtPct(w.human.winRate, 0)})` : '–'}
                    </td>
                    <td className={`num ${signClass(w.human.net)}`}>{w.human.n ? fmtUnits(w.human.net) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h2>
          Lessons <span className="right muted small">written by the Tuesday review; proposals wait for your call</span>
        </h2>
        {lessons.length === 0 ? (
          <div className="empty">Nothing yet. The Tuesday review writes observations here and, once there is enough evidence, proposes playbook changes for you to adopt or reject.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {lessons.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <span className={`badge ${l.kind === 'proposal' ? (l.status === 'adopted' ? 'win' : l.status === 'rejected' ? 'loss' : 'pending') : 'passed'}`}>{l.kind === 'proposal' ? l.status : 'note'}</span>
                    </td>
                    <td className="wrap">
                      {l.text}
                      {l.evidence ? <div className="muted small">{l.evidence}</div> : null}
                    </td>
                    <td className="muted small">{new Date(l.created_at).toLocaleDateString()}</td>
                    <td>
                      {l.kind === 'proposal' && l.status === 'open' && (
                        <span className="row">
                          <button className="btn sm execute" onClick={() => api.setLessonStatus(l.id, 'adopted').then(load)}>
                            Adopt
                          </button>
                          <button className="btn sm" onClick={() => api.setLessonStatus(l.id, 'rejected').then(load)}>
                            Reject
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>
          Reviews
          <span className="right">
            <button className="btn sm" disabled={busy || sb.engine.n === 0} onClick={runReview}>
              Write review now
            </button>
          </span>
        </h2>
        {reviews.length === 0 ? (
          <div className="empty">A review is written every Tuesday morning once picks have settled. Read it before the next scan.</div>
        ) : (
          reviews.slice(0, 5).map((r) => (
            <details key={r.id} style={{ marginBottom: 8 }}>
              <summary>
                {r.label} <span className="muted small">({new Date(r.created_at).toLocaleString()})</span>
              </summary>
              {r.narrative && <div className="prose" style={{ margin: '10px 0' }}>{r.narrative}</div>}
              <pre>{r.report_md}</pre>
            </details>
          ))
        )}
      </div>
    </div>
  );
}
