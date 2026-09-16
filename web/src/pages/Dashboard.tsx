import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, fmtPct, fmtUnits, signClass, type Dashboard as DashboardData, type Status, type WeekTab } from '../api';
import { WeekView } from '../components/WeekView';
import { useToast } from '../toast';

export function Dashboard({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<DashboardData | null>(null);
  const [weeks, setWeeks] = useState<WeekTab[]>([]);
  const [weekKey, setWeekKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const [d, w] = await Promise.all([api.dashboard(), api.weeks()]);
      setData(d);
      setWeeks(w);
      // Land on the current week the first time; keep the user's choice after that.
      setWeekKey((cur) => (cur && w.some((t) => t.key === cur) ? cur : (w.find((t) => t.current) ?? w[w.length - 1])?.key ?? null));
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

      <div className="weekbar">
        <div className="weektabs">
          {weeks.map((w) => (
            <button key={w.key} className={w.key === weekKey ? 'active' : ''} onClick={() => setWeekKey(w.key)} title={w.sublabel}>
              <span className="wk">{w.label}</span>
              <span className="sub">
                {w.sublabel}
                {w.pending > 0 ? ` · ${w.pending} to decide` : w.picks > 0 ? ` · ${w.picks} picks` : ''}
              </span>
            </button>
          ))}
          {weeks.length === 0 && <span className="muted small">No weeks loaded yet — run the packet.</span>}
        </div>
        <button className="btn sm" disabled={busy} onClick={grade}>
          Refresh scores &amp; grade
        </button>
      </div>

      {weekKey && <WeekView key={weekKey} weekKey={weekKey} tz={tz} settings={data.settings} anthropicConfigured={status.anthropicConfigured} onChanged={changed} refreshKey={refreshKey} />}
    </div>
  );
}
