import { useEffect, useState } from 'react';
import { api, fmtTime, type League, type Run, type RunDetail, type Status } from '../api';
import { ProposalCard } from '../components/ProposalCard';
import { useToast } from '../toast';

export function Runs({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const toast = useToast();
  const [runs, setRuns] = useState<Run[]>([]);
  const [open, setOpen] = useState<RunDetail | null>(null);
  const [note, setNote] = useState('');
  const [leagues, setLeagues] = useState<League[]>(['nfl', 'cfb']);
  const [busy, setBusy] = useState(false);
  const [packet, setPacket] = useState<string | null>(null);
  const [events, setEvents] = useState<{ id: number; ts: string; level: string; message: string }[]>([]);

  const load = async () => {
    try {
      const [r, e] = await Promise.all([api.runs(), api.events()]);
      setRuns(r);
      setEvents(e);
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openRun = async (id: number) => {
    try {
      setOpen(await api.run(id));
    } catch (e) {
      toast('err', (e as Error).message);
    }
  };

  const scan = async () => {
    setBusy(true);
    try {
      await api.scan(note || undefined, leagues);
      toast('info', 'Scan started. It researches with web search and can take several minutes; this page refreshes itself.');
      setNote('');
      onChanged();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const showPacket = async () => {
    setBusy(true);
    setPacket('Building packet…');
    try {
      const r = await api.packet(leagues);
      setPacket(r.markdown);
    } catch (e) {
      setPacket(null);
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (l: League) => setLeagues((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]));

  return (
    <div className="grid">
      <div className="card">
        <h2>New analysis</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="row small">
            <input type="checkbox" checked={leagues.includes('nfl')} onChange={() => toggle('nfl')} /> NFL
          </label>
          <label className="row small">
            <input type="checkbox" checked={leagues.includes('cfb')} onChange={() => toggle('cfb')} /> College
          </label>
          <input type="text" style={{ flex: 1, minWidth: 220 }} placeholder="note for the engine (optional): e.g. 'only totals this week'" value={note} onChange={(e) => setNote(e.target.value)} />
          {status.anthropicConfigured ? (
            <button className="btn primary" disabled={busy || status.scanRunning || leagues.length === 0} onClick={scan}>
              {status.scanRunning ? 'Scan running…' : 'Run scan (API)'}
            </button>
          ) : (
            <span className="muted small">No API key: use a Claude Code session (packet → propose).</span>
          )}
          <button className="btn" disabled={busy || leagues.length === 0} onClick={showPacket}>
            View packet
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Session flow: <code>npm run packet</code> prints this packet; reason with <code>server/src/engine/prompt.ts</code>; save JSON to <code>data/response.json</code>; <code>npm run propose -- --file data/response.json</code>.
        </p>
        {packet && (
          <details open style={{ marginTop: 10 }}>
            <summary>Packet ({packet.length.toLocaleString()} chars)</summary>
            <pre>{packet}</pre>
          </details>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Runs</h2>
          {runs.length === 0 ? (
            <div className="empty">No runs yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Week</th>
                    <th>Engine</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} onClick={() => openRun(r.id)} style={{ cursor: 'pointer', background: open?.id === r.id ? 'var(--bg-3)' : undefined }}>
                      <td className="muted">{fmtTime(r.started_at, status.displayTz)}</td>
                      <td>{r.week_label}</td>
                      <td>
                        {r.engine}
                        {!r.finished_at && !r.error ? <span className="badge pending"> running</span> : ''}
                        {r.error ? <span className="badge loss"> error</span> : ''}
                      </td>
                      <td className="wrap muted small" style={{ maxWidth: 420 }}>
                        {r.error ?? r.summary ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h2>Log</h2>
          <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="muted small">{fmtTime(e.ts, status.displayTz)}</td>
                    <td className={`wrap small ${e.level === 'error' ? 'neg' : e.level === 'warn' ? 'warn' : ''}`}>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {open && (
        <div className="card">
          <h2>
            Run #{open.id} · {open.week_label} · {open.engine}
            {open.response?.model ? ` · ${open.response.model}` : ''}
            {open.response?.searches ? ` · ${open.response.searches} searches` : ''}
            {open.input_tokens ? ` · ${open.input_tokens.toLocaleString()} in / ${open.output_tokens?.toLocaleString()} out` : ''}
            <span className="right">
              <button className="btn sm" onClick={() => setOpen(null)}>
                close
              </button>
            </span>
          </h2>
          {open.error && <div className="bear">Error: {open.error}</div>}
          {open.response && (
            <>
              <div className="prose">{open.response.week_summary}</div>
              {open.response.red_summary && (
                <p className="muted">
                  <b>Red team:</b> {open.response.red_summary}
                </p>
              )}
              {open.response.teaching_note && (
                <p>
                  <b>Teaching note:</b> {open.response.teaching_note}
                </p>
              )}
              {open.response.passes?.length > 0 && (
                <details>
                  <summary>Considered and passed ({open.response.passes.length})</summary>
                  <ul>
                    {open.response.passes.map((p, i) => (
                      <li key={i}>
                        <span className="mono muted">{p.game_id}</span> — {p.note}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {open.response.dropped && open.response.dropped.length > 0 && (
                <details>
                  <summary>Dropped by the rails ({open.response.dropped.length})</summary>
                  <ul>
                    {open.response.dropped.map((d, i) => (
                      <li key={i}>
                        {d.pick} — <span className="warn">{d.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          <div className="grid" style={{ marginTop: 10 }}>
            {open.proposals.map((p) => (
              <ProposalCard key={p.id} p={p} tz={status.displayTz} maxUnits={status.settings.maxUnitsPerBet} onChanged={() => openRun(open.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
