/**
 * The scoreboard. Engine = every graded proposal at its proposed stake (what Claude would have
 * done alone). You = only what you executed, at the stake you chose. Passed = what you left
 * on the table. Leans = every board read, graded as if bet 1u, by confidence (calibration).
 * Baselines = dumb strategies on the same games at the closing line, so "+3u" has a comparison.
 * Break-even at -110 is 52.38%.
 */
import { db, getSettings, type ProposalRow } from './db.js';
import { breakEvenRate, netUnits, settle, type Lines } from './odds.js';
import type { Market, Side } from './engine/schema.js';

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
  avgClvPrice: number | null; // implied-probability points vs the closing price
};

type Scored = { result: ProposalRow['result']; stake: number; net: number; clv: number | null; clvPrice?: number | null };

function bucket(rows: Scored[]): Bucket {
  const wins = rows.filter((r) => r.result === 'win').length;
  const losses = rows.filter((r) => r.result === 'loss').length;
  const pushes = rows.filter((r) => r.result === 'push').length;
  const staked = rows.reduce((a, r) => a + r.stake, 0);
  const net = rows.reduce((a, r) => a + r.net, 0);
  const withClv = rows.filter((r) => r.clv !== null && Number.isFinite(r.clv));
  const withClvPrice = rows.filter((r) => r.clvPrice !== null && r.clvPrice !== undefined && Number.isFinite(r.clvPrice));
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
    avgClvPrice: withClvPrice.length ? withClvPrice.reduce((a, r) => a + (r.clvPrice as number), 0) / withClvPrice.length : null,
  };
}

type ScoredRow = Scored & { row: ProposalRow };

const engineView = (p: ProposalRow): ScoredRow => ({ row: p, result: p.result, stake: p.units, net: p.units_net ?? 0, clv: p.clv, clvPrice: p.clv_price });
const humanView = (p: ProposalRow): ScoredRow => {
  const stake = p.executed_units ?? p.units;
  const scale = p.units ? stake / p.units : 1;
  return { row: p, result: p.result, stake, net: (p.units_net ?? 0) * scale, clv: p.clv, clvPrice: p.clv_price };
};

function groupBy(rows: ScoredRow[], key: (p: ProposalRow) => string): Record<string, Bucket> {
  const groups = new Map<string, ScoredRow[]>();
  for (const r of rows) {
    const k = key(r.row);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, bucket(v)]));
}

const confBucket = (c: number) => (c >= 8 ? '8+' : String(c));

// ---- board leans ------------------------------------------------------------

type LeanRow = { game_id: string; league: string; confidence: number; market: Market; side: Side; line: number | null; price: number; result: 'win' | 'loss' | 'push' };

/** Latest graded lean per game, scored as a 1u bet at the lean's own line and price. */
function gradedLeans(): LeanRow[] {
  return db
    .prepare(
      `SELECT v.game_id, g.league, v.confidence, v.market, v.side, v.line, v.price, v.result
       FROM game_views v JOIN games g ON g.id = v.game_id
       WHERE v.result IS NOT NULL`,
    )
    .all() as LeanRow[];
}

const leanScore = (l: LeanRow): Scored => ({ result: l.result, stake: 1, net: netUnits(l.result, 1, l.price), clv: null });

export type LeanStats = {
  all: Bucket;
  /** Confidence buckets in order: 1-2, 3, 4, 5, 6, 7+. The whole point: do the 5s beat the 3s? */
  byConfidence: { label: string; bucket: Bucket }[];
  byLeague: Record<string, Bucket>;
  byMarket: Record<string, Bucket>;
  /** Leans at the pick threshold (5+) but not proposed as picks: the engine's "almost" pile. */
  wouldBePicks: Bucket;
};

function leanStats(): LeanStats {
  const leans = gradedLeans();
  const confLabel = (c: number) => (c <= 2 ? '1-2' : c >= 7 ? '7+' : String(c));
  const order = ['1-2', '3', '4', '5', '6', '7+'];
  const byConf = new Map<string, LeanRow[]>();
  for (const l of leans) {
    const k = confLabel(l.confidence);
    if (!byConf.has(k)) byConf.set(k, []);
    byConf.get(k)!.push(l);
  }
  const grp = (key: (l: LeanRow) => string) => {
    const m = new Map<string, LeanRow[]>();
    for (const l of leans) {
      const k = key(l);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(l);
    }
    return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, bucket(v.map(leanScore))]));
  };
  const picked = new Set((db.prepare(`SELECT game_id FROM proposals WHERE origin = 'engine' AND status != 'void'`).all() as { game_id: string }[]).map((r) => r.game_id));
  return {
    all: bucket(leans.map(leanScore)),
    byConfidence: order.filter((k) => byConf.has(k)).map((k) => ({ label: `conf ${k}`, bucket: bucket(byConf.get(k)!.map(leanScore)) })),
    byLeague: grp((l) => l.league),
    byMarket: grp((l) => l.market),
    wouldBePicks: bucket(leans.filter((l) => l.confidence >= 5 && !picked.has(l.game_id)).map(leanScore)),
  };
}

// ---- baselines --------------------------------------------------------------

type FinalGame = { id: string; league: string; home_score: number; away_score: number; closing: Lines };

/** Every final game with a frozen closing line, in the weeks the experiment has covered. */
function finalGames(): FinalGame[] {
  const rows = db
    .prepare(`SELECT id, league, home_score, away_score, lines_closing_json FROM games WHERE status = 'final' AND lines_closing_json IS NOT NULL AND home_score IS NOT NULL AND away_score IS NOT NULL`)
    .all() as { id: string; league: string; home_score: number; away_score: number; lines_closing_json: string }[];
  return rows.map((r) => ({ id: r.id, league: r.league, home_score: r.home_score, away_score: r.away_score, closing: JSON.parse(r.lines_closing_json) as Lines }));
}

/** A rule applied to every game at the close: returns the bet to make, or null to sit out. */
type Rule = (g: FinalGame) => { market: Market; side: Side; line: number | null; price: number } | null;

const RULES: Record<string, Rule> = {
  // The classic square fade: take the points at home.
  'Home underdog +pts': (g) => (g.closing.spreadHome !== null && g.closing.spreadHome > 0 ? { market: 'spread', side: 'home', line: g.closing.spreadHome, price: g.closing.spreadHomePrice ?? -110 } : null),
  'Road underdog +pts': (g) => (g.closing.spreadHome !== null && g.closing.spreadHome < 0 ? { market: 'spread', side: 'away', line: -g.closing.spreadHome, price: g.closing.spreadAwayPrice ?? -110 } : null),
  'Every favorite -pts': (g) => {
    if (g.closing.spreadHome === null || g.closing.spreadHome === 0) return null;
    return g.closing.spreadHome < 0
      ? { market: 'spread', side: 'home', line: g.closing.spreadHome, price: g.closing.spreadHomePrice ?? -110 }
      : { market: 'spread', side: 'away', line: -g.closing.spreadHome, price: g.closing.spreadAwayPrice ?? -110 };
  },
  'Every under': (g) => (g.closing.total !== null ? { market: 'total', side: 'under', line: g.closing.total, price: g.closing.underPrice ?? -110 } : null),
  'Every over': (g) => (g.closing.total !== null ? { market: 'total', side: 'over', line: g.closing.total, price: g.closing.overPrice ?? -110 } : null),
};

export type Baselines = Record<string, Bucket>;

function baselines(): Baselines {
  const games = finalGames();
  const out: Baselines = {};
  for (const [name, rule] of Object.entries(RULES)) {
    const rows: Scored[] = [];
    for (const g of games) {
      const bet = rule(g);
      if (!bet) continue;
      const s = settle(bet.market, bet.side, bet.line, g.home_score, g.away_score);
      rows.push({ result: s.result, stake: 1, net: netUnits(s.result, 1, bet.price), clv: null }); // CLV does not apply: these are bet at the close by definition
    }
    out[name] = bucket(rows);
  }
  return out;
}

// ---- the scoreboard -----------------------------------------------------------

export type Scoreboard = {
  generatedAt: string;
  breakEven: number;
  unitDollars: number;
  bankroll: { start: number; now: number; peak: number; drawdown: number };
  engine: Bucket;
  human: Bucket;
  passed: Bucket;
  /** Board leans the user chose to bet from the dashboard (origin = lean). Not the engine's record. */
  leanBets: Bucket;
  leans: LeanStats;
  baselines: Baselines;
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
  const leanBets = graded.filter((p) => p.origin === 'lean').map(humanView);

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
  } else if (humanB.n >= 10 && passedB.n === 0) {
    verdict = 'You have executed every pick, so "you" and "the engine" are the same record. The filter only becomes measurable if you pass on some.';
  }

  return {
    generatedAt: new Date().toISOString(),
    breakEven: breakEvenRate(-110),
    unitDollars: s.unitDollars,
    bankroll: { start: s.bankrollUnits, now: round(s.bankrollUnits + humanCum), peak: round(s.bankrollUnits + peak), drawdown: round(peak - humanCum) },
    engine: bucket(engine),
    human: humanB,
    passed: passedB,
    leanBets: bucket(leanBets),
    leans: leanStats(),
    baselines: baselines(),
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
