/**
 * The scoreboard. Engine = every graded proposal at its proposed stake (what Claude would have
 * done alone). You = only what you executed, at the stake you chose. Passed = what you left
 * on the table. Break-even at -110 is 52.38%.
 */
import { db, getSettings, type ProposalRow } from './db.js';
import { breakEvenRate } from './odds.js';

export type Bucket = {
  n: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number | null; // wins / (wins + losses)
  staked: number;
  net: number;
  roi: number | null; // net / staked
  avgClv: number | null;
  clvBeatRate: number | null; // share of picks that beat the closing number
};

function bucket(rows: { result: ProposalRow['result']; stake: number; net: number; clv: number | null }[]): Bucket {
  const wins = rows.filter((r) => r.result === 'win').length;
  const losses = rows.filter((r) => r.result === 'loss').length;
  const pushes = rows.filter((r) => r.result === 'push').length;
  const staked = rows.reduce((a, r) => a + r.stake, 0);
  const net = rows.reduce((a, r) => a + r.net, 0);
  const withClv = rows.filter((r) => r.clv !== null && Number.isFinite(r.clv));
  return {
    n: rows.length,
    wins,
    losses,
    pushes,
    winRate: wins + losses ? wins / (wins + losses) : null,
    staked,
    net,
    roi: staked ? net / staked : null,
    avgClv: withClv.length ? withClv.reduce((a, r) => a + (r.clv as number), 0) / withClv.length : null,
    clvBeatRate: withClv.length ? withClv.filter((r) => (r.clv as number) > 0).length / withClv.length : null,
  };
}

type Scored = { row: ProposalRow; result: ProposalRow['result']; stake: number; net: number; clv: number | null };

const engineView = (p: ProposalRow): Scored => ({ row: p, result: p.result, stake: p.units, net: p.units_net ?? 0, clv: p.clv });
const humanView = (p: ProposalRow): Scored => {
  const stake = p.executed_units ?? p.units;
  const scale = p.units ? stake / p.units : 1;
  return { row: p, result: p.result, stake, net: (p.units_net ?? 0) * scale, clv: p.clv };
};

function groupBy(rows: Scored[], key: (p: ProposalRow) => string): Record<string, Bucket> {
  const groups = new Map<string, Scored[]>();
  for (const r of rows) {
    const k = key(r.row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, bucket(v)]));
}

const confBucket = (c: number) => (c >= 8 ? '8+' : String(c));

export type Scoreboard = {
  generatedAt: string;
  breakEven: number;
  unitDollars: number;
  bankroll: { start: number; now: number; peak: number; drawdown: number };
  engine: Bucket;
  human: Bucket;
  passed: Bucket;
  leans: Bucket;
  pending: number;
  humanEdge: { verdict: string; executedRoi: number | null; passedRoi: number | null };
  byLeague: Record<string, Bucket>;
  byMarket: Record<string, Bucket>;
  byEdge: Record<string, Bucket>;
  byConfidence: Record<string, Bucket>;
  byWeek: { key: string; label: string; engine: Bucket; human: Bucket }[];
  series: { id: number; kickoff: string; pick: string; result: string; executed: boolean; engineCum: number; humanCum: number }[];
};

export function computeScoreboard(): Scoreboard {
  const s = getSettings();
  const graded = db.prepare(`SELECT * FROM proposals WHERE graded_at IS NOT NULL AND status != 'void' ORDER BY kickoff ASC, id ASC`).all() as ProposalRow[];
  const pending = (db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'`).get() as { n: number }).n;

  // The engine is scored only on what it proposed as a pick; leans the user chose to bet are their own bucket.
  const enginePicks = graded.filter((p) => p.origin !== 'lean');
  const engine = enginePicks.map(engineView);
  const executed = graded.filter((p) => p.status === 'executed').map(humanView);
  const passed = enginePicks.filter((p) => p.status === 'passed').map(engineView);
  const leans = graded.filter((p) => p.origin === 'lean').map(humanView);

  let engineCum = 0;
  let humanCum = 0;
  let peak = 0;
  const series = graded.map((p) => {
    if (p.origin !== 'lean') engineCum += p.units_net ?? 0;
    if (p.status === 'executed') humanCum += humanView(p).net;
    peak = Math.max(peak, humanCum);
    return { id: p.id, kickoff: p.kickoff, pick: `${p.matchup}: ${p.pick}`, result: p.result ?? '', executed: p.status === 'executed', engineCum: round(engineCum), humanCum: round(humanCum) };
  });

  const weekKey = (p: ProposalRow) => `${p.season}-${String(p.week).padStart(2, '0')}-${p.league}`;
  const weekKeys = [...new Set(graded.map(weekKey))].sort();
  const byWeek = weekKeys.map((k) => ({
    key: k,
    label: `${k.endsWith('nfl') ? 'NFL' : 'CFB'} wk ${Number(k.split('-')[1])}`,
    engine: bucket(engine.filter((r) => weekKey(r.row) === k)),
    human: bucket(executed.filter((r) => weekKey(r.row) === k)),
  }));

  const humanB = bucket(executed);
  const passedB = bucket(passed);
  let verdict = 'Not enough settled bets to judge your filter yet.';
  if (humanB.n >= 10 && passedB.n >= 5 && humanB.roi !== null && passedB.roi !== null) {
    verdict =
      humanB.roi > passedB.roi + 0.05
        ? 'Your execute/pass filter is adding value: what you took is beating what you passed.'
        : passedB.roi > humanB.roi + 0.05
          ? 'What you passed on is doing better than what you took. Consider executing more of the engine\'s picks as-is.'
          : 'Your filter is roughly neutral so far; the engine\'s picks and your selection are performing about the same.';
  }

  return {
    generatedAt: new Date().toISOString(),
    breakEven: breakEvenRate(-110),
    unitDollars: s.unitDollars,
    bankroll: { start: s.bankrollUnits, now: round(s.bankrollUnits + humanCum), peak: round(s.bankrollUnits + peak), drawdown: round(peak - humanCum) },
    engine: bucket(engine),
    human: humanB,
    passed: passedB,
    leans: bucket(leans),
    pending,
    humanEdge: { verdict, executedRoi: humanB.roi, passedRoi: passedB.roi },
    byLeague: groupBy(engine, (p) => p.league),
    byMarket: groupBy(engine, (p) => p.market),
    byEdge: groupBy(engine, (p) => p.edge_type),
    byConfidence: groupBy(engine, (p) => confBucket(p.confidence)),
    byWeek,
    series,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
