/**
 * The weekly review. `buildReviewPacket()` renders everything a reviewer needs to judge last week
 * honestly: the picks with their theses against what happened, the leans by confidence, the
 * baselines, the passes, and whether Monday's number beat Thursday's. A Claude session (the Tuesday
 * task) reads it and writes back a review file — narrative, observations, and any proposed playbook
 * change — which `storeReview()` records. Proposals are for the user to adopt or reject; the engine
 * never edits its own playbook, and the guardrails below say how much evidence a proposal needs.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { config, hasAnthropicKey, LEAGUE_LABEL } from './config.js';
import { db, listLessons, nowIso, type ProposalRow } from './db.js';
import { fmtLine, fmtPrice, pickedFrom, type Lines } from './odds.js';
import { computeScoreboard, type Bucket } from './stats.js';
import { runNarrative } from './engine/narrative.js';

/** Minimum evidence before a playbook change may even be proposed. Below these, write an observation. */
export const GUARDRAILS = {
  minPicksForRule: 30, // graded engine picks before any claim about pick selection
  minLeansForCalibration: 150, // graded leans before any claim about the confidence scale
  minPerBucket: 25, // graded items in a specific bucket (league, market, edge type) before a claim about that bucket
};

const pct = (n: number | null) => (n === null ? '–' : `${(n * 100).toFixed(1)}%`);
const units = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}u`);
const row = (label: string, b: Bucket) =>
  `| ${label} | ${b.wins}-${b.losses}${b.pushes ? `-${b.pushes}` : ''} | ${pct(b.winRate)} | ${units(b.net)} | ${pct(b.roi)} | ${b.avgClv === null ? '–' : (b.avgClv >= 0 ? '+' : '') + b.avgClv.toFixed(2)} |`;
const header = '| Slice | W-L-P | Win % | Units | ROI | Avg CLV |\n|---|---|---|---|---|---|';
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: config.displayTz, weekday: 'short', month: 'short', day: 'numeric' });

/** First snapshot at or after Monday 00:00 local of the pick's week, so we can ask "would Monday's number have been better?" */
function mondayLineFor(p: ProposalRow): { line: number | null; price: number | null; ts: string } | null {
  const kick = new Date(p.kickoff);
  // Walk back to the Monday before kickoff (kickoffs are Thu-Mon; a Monday kickoff belongs to the prior Monday).
  const d = new Date(kick);
  d.setUTCHours(12, 0, 0, 0);
  while (d.getUTCDay() !== 1 || d >= kick) d.setUTCDate(d.getUTCDate() - 1);
  const snap = db.prepare('SELECT ts, lines_json FROM line_snapshots WHERE game_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1').get(p.game_id, d.toISOString()) as { ts: string; lines_json: string } | undefined;
  if (!snap) return null;
  const cur = pickedFrom(JSON.parse(snap.lines_json) as Lines, p.market, p.side);
  return { line: cur.line, price: cur.price, ts: snap.ts };
}

export function buildReviewPacket(): string {
  const sb = computeScoreboard();
  const md: string[] = [];
  md.push(`# Review packet — ${new Date().toLocaleDateString('en-US', { timeZone: config.displayTz, month: 'long', day: 'numeric', year: 'numeric' })}`, '');
  md.push(
    `Break-even at -110 is ${pct(sb.breakEven)}. Engine ${sb.engine.wins}-${sb.engine.losses}-${sb.engine.pushes} (${pct(sb.engine.winRate)}), ${units(sb.engine.net)}, avg CLV ${sb.engine.avgClv?.toFixed(2) ?? '–'} pts / ${sb.engine.avgClvPrice?.toFixed(1) ?? '–'} price pts. ` +
      `Guardrails: no playbook proposal on pick selection under ${GUARDRAILS.minPicksForRule} graded picks, on the confidence scale under ${GUARDRAILS.minLeansForCalibration} graded leans, or on a league/market/edge bucket under ${GUARDRAILS.minPerBucket} items. Below those, write observations, not proposals.`,
    '',
  );

  // ---- last week's picks, thesis vs outcome
  const recentWeekKeys = (db.prepare(`SELECT DISTINCT league, season, week FROM proposals WHERE graded_at > datetime('now', '-8 days') AND origin = 'engine'`).all() as { league: string; season: number; week: number }[]);
  const picks = recentWeekKeys.length
    ? (db
        .prepare(`SELECT * FROM proposals WHERE origin = 'engine' AND status != 'void' AND (${recentWeekKeys.map(() => '(league = ? AND season = ? AND week = ?)').join(' OR ')}) ORDER BY kickoff`)
        .all(...recentWeekKeys.flatMap((k) => [k.league, k.season, k.week])) as ProposalRow[])
    : [];
  md.push(`## Last week's picks (${picks.length})`, '');
  if (!picks.length) md.push('No graded picks in the last eight days.', '');
  for (const p of picks) {
    const g = db.prepare('SELECT home_abbr, away_abbr, home_score, away_score, status, lines_closing_json FROM games WHERE id = ?').get(p.game_id) as { home_abbr: string; away_abbr: string; home_score: number | null; away_score: number | null; status: string; lines_closing_json: string | null } | undefined;
    const mon = mondayLineFor(p);
    const monTxt = mon && mon.line !== null ? `Monday number was ${p.market === 'total' ? mon.line : fmtLine(mon.line)} (${fmtPrice(mon.price)})` : 'no Monday snapshot';
    md.push(`### ${p.result ? p.result.toUpperCase() : p.status.toUpperCase()} — ${p.matchup}: ${p.pick} · conf ${p.confidence} · ${p.edge_type} · ${p.status}${p.units_net !== null ? ` · ${units(p.units_net)}` : ''}`);
    md.push(`${when(p.kickoff)}${g && g.home_score !== null ? ` · final ${g.away_abbr} ${g.away_score}–${g.home_score} ${g.home_abbr}` : ''}${p.cover_margin !== null ? ` · margin ${p.cover_margin > 0 ? '+' : ''}${p.cover_margin}` : ''}${p.closing_line !== null ? ` · closed ${p.market === 'total' ? p.closing_line : fmtLine(p.closing_line)} (${fmtPrice(p.closing_price)})` : ''}${p.clv !== null ? ` · CLV ${p.clv >= 0 ? '+' : ''}${p.clv.toFixed(1)} pts` : ''}${p.clv_price !== null ? ` / ${p.clv_price >= 0 ? '+' : ''}${p.clv_price.toFixed(1)} price` : ''} · ${monTxt}`);
    md.push(`- Thesis: ${p.thesis}`);
    md.push(`- Bear case: ${p.bear_case}`);
    if (p.key_factors_json) md.push(`- Factors: ${(JSON.parse(p.key_factors_json) as string[]).join(' | ')}`);
    md.push('');
  }

  // ---- passes: what we declined, and what happened
  const runs = db.prepare(`SELECT id, week_label, response_json FROM runs WHERE response_json IS NOT NULL AND started_at > datetime('now', '-8 days') ORDER BY id`).all() as { id: number; week_label: string; response_json: string }[];
  const passes: string[] = [];
  for (const r of runs) {
    const resp = JSON.parse(r.response_json) as { passes?: { game_id: string; note: string }[] };
    for (const ps of resp.passes ?? []) {
      const g = db.prepare('SELECT name, home_score, away_score, status, lines_closing_json FROM games WHERE id = ?').get(ps.game_id) as { name: string; home_score: number | null; away_score: number | null; status: string; lines_closing_json: string | null } | undefined;
      if (!g) continue;
      const c = g.lines_closing_json ? (JSON.parse(g.lines_closing_json) as Lines) : null;
      passes.push(`- ${g.name}${g.home_score !== null ? ` — final ${g.away_score}–${g.home_score}` : ''}${c?.spreadHome !== null && c?.spreadHome !== undefined ? ` (closed home ${fmtLine(c.spreadHome)}, total ${c.total})` : ''}: ${ps.note}`);
    }
  }
  md.push(`## Passes (${passes.length})`, '', ...(passes.length ? passes : ['None recorded.']), '');

  // ---- leans
  md.push('## Board leans, graded as 1u bets at the lean\'s own line', '', header);
  md.push(row('All leans', sb.leans.all));
  for (const b of sb.leans.byConfidence) md.push(row(b.label, b.bucket));
  for (const [k, b] of Object.entries(sb.leans.byLeague)) md.push(row(`League ${k}`, b));
  for (const [k, b] of Object.entries(sb.leans.byMarket)) md.push(row(`Market ${k}`, b));
  md.push(row('Leans at 5+ that were NOT picks', sb.leans.wouldBePicks));
  md.push('');

  // ---- baselines
  md.push('## Baselines (dumb rules on every final game at the closing line)', '', header);
  for (const [k, b] of Object.entries(sb.baselines)) md.push(row(k, b));
  md.push('');

  // ---- season scoreboard
  md.push('## Season scoreboard (engine picks)', '', header);
  md.push(row('All picks', sb.engine), row('You (executed)', sb.human), row('Passed', sb.passed));
  for (const [k, b] of Object.entries(sb.byLeague)) md.push(row(`League ${LEAGUE_LABEL[k as 'nfl' | 'cfb'] ?? k}`, b));
  for (const [k, b] of Object.entries(sb.byMarket)) md.push(row(`Market ${k}`, b));
  for (const [k, b] of Object.entries(sb.byEdge)) md.push(row(`Edge ${k}`, b));
  for (const [k, b] of Object.entries(sb.byConfidence)) md.push(row(`Confidence ${k}`, b));
  md.push('', `Filter verdict: ${sb.humanEdge.verdict}`, '');

  // ---- lessons so far
  const lessons = listLessons(20);
  md.push(`## Lessons on file (${lessons.length})`, '');
  for (const l of lessons) md.push(`- [${l.kind}${l.kind === 'proposal' ? `, ${l.status}` : ''}] ${l.text}${l.evidence ? ` — ${l.evidence}` : ''}`);
  if (!lessons.length) md.push('None yet.');
  md.push('');

  md.push('## What to write back', '');
  md.push(
    'A JSON file matching ReviewResponseSchema (server/src/review.ts): narrative (150-300 words: what the numbers say, respecting sample sizes; for each loss, was the thesis wrong or was it variance — did the bear case name what actually happened; were the passes right; did Monday\'s number beat Thursday\'s), observations[] (short, specific, with the evidence), proposals[] (playbook changes ONLY where the guardrails are met; each with the evidence and sample size; empty is the normal answer this early), and next_week_focus (one sentence for Thursday\'s run).',
  );
  return md.join('\n');
}

export const ReviewResponseSchema = z.object({
  narrative: z.string().min(50),
  observations: z.array(z.object({ text: z.string().min(5), evidence: z.string().default('') })).max(10),
  proposals: z.array(z.object({ text: z.string().min(5), evidence: z.string().min(5) })).max(3),
  next_week_focus: z.string().default(''),
});
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/** Record a review written by a session (or the API narrative) plus its lessons. */
export function storeReview(resp: ReviewResponse, label?: string): { id: number; lessons: number } {
  const sb = computeScoreboard();
  const title = label ?? `Review through ${new Date().toISOString().slice(0, 10)}`;
  const report = buildReviewPacket();
  const r = db.prepare('INSERT INTO reviews (created_at, label, stats_json, report_md, narrative) VALUES (?, ?, ?, ?, ?)').run(nowIso(), title, JSON.stringify(sb), report, resp.narrative + (resp.next_week_focus ? `\n\nNext week: ${resp.next_week_focus}` : ''));
  const id = Number(r.lastInsertRowid);
  const ins = db.prepare('INSERT INTO lessons (created_at, review_id, kind, text, evidence, status) VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const o of resp.observations) {
    ins.run(nowIso(), id, 'observation', o.text, o.evidence || null, 'open');
    n++;
  }
  for (const p of resp.proposals) {
    ins.run(nowIso(), id, 'proposal', p.text, p.evidence, 'open');
    n++;
  }
  if (resp.next_week_focus) {
    ins.run(nowIso(), id, 'observation', `Focus for next week: ${resp.next_week_focus}`, null, 'open');
    n++;
  }
  return { id, lessons: n };
}

/** Stats-only review with an API narrative when a key is present (fallback when no session runs the review). */
export async function buildReview(label?: string): Promise<{ id: number; report: string }> {
  const report = buildReviewPacket();
  let narrative: string | null = null;
  if (hasAnthropicKey()) {
    try {
      narrative = await runNarrative(report);
    } catch (e) {
      narrative = `(narrative failed: ${(e as Error).message})`;
    }
  }
  const sb = computeScoreboard();
  const r = db.prepare('INSERT INTO reviews (created_at, label, stats_json, report_md, narrative) VALUES (?, ?, ?, ?, ?)').run(nowIso(), label ?? `Review through ${new Date().toISOString().slice(0, 10)}`, JSON.stringify(sb), report, narrative);
  return { id: Number(r.lastInsertRowid), report: narrative ? `${report}\n\n## Narrative\n\n${narrative}` : report };
}

export function readReviewFile(file: string): ReviewResponse {
  return ReviewResponseSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}
