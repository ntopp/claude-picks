/**
 * Weekly review: a markdown report of the scoreboard plus, when the API engine is available,
 * a short narrative on what worked and what to change. Read it before the next scan.
 */
import { db, nowIso, type ProposalRow } from './db.js';
import { computeScoreboard, type Bucket } from './stats.js';
import { hasAnthropicKey } from './config.js';
import { runNarrative } from './engine/narrative.js';

const pct = (n: number | null) => (n === null ? '–' : `${(n * 100).toFixed(1)}%`);
const units = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}u`;
const line = (label: string, b: Bucket) =>
  `| ${label} | ${b.wins}-${b.losses}${b.pushes ? `-${b.pushes}` : ''} | ${pct(b.winRate)} | ${units(b.net)} | ${pct(b.roi)} | ${b.avgClv === null ? '–' : (b.avgClv >= 0 ? '+' : '') + b.avgClv.toFixed(2)} |`;

export async function buildReview(label?: string): Promise<{ id: number; report: string }> {
  const sb = computeScoreboard();
  const recent = db.prepare(`SELECT * FROM proposals WHERE graded_at IS NOT NULL AND status != 'void' ORDER BY kickoff DESC LIMIT 25`).all() as ProposalRow[];
  const title = label ?? `Review through ${new Date().toISOString().slice(0, 10)}`;
  const md: string[] = [`# ${title}`, ''];
  md.push(`Break-even at -110 is ${pct(sb.breakEven)}. Bankroll ${sb.bankroll.now}u of ${sb.bankroll.start}u start (peak ${sb.bankroll.peak}u).`, '');
  md.push('| Slice | W-L-P | Win % | Units | ROI | Avg CLV |', '|---|---|---|---|---|---|');
  md.push(line('Engine (all picks)', sb.engine));
  md.push(line('You (executed)', sb.human));
  md.push(line('Passed', sb.passed));
  for (const [k, b] of Object.entries(sb.byLeague)) md.push(line(`League: ${k}`, b));
  for (const [k, b] of Object.entries(sb.byMarket)) md.push(line(`Market: ${k}`, b));
  for (const [k, b] of Object.entries(sb.byEdge)) md.push(line(`Edge: ${k}`, b));
  for (const [k, b] of Object.entries(sb.byConfidence)) md.push(line(`Confidence ${k}`, b));
  md.push('', `**Filter verdict:** ${sb.humanEdge.verdict}`, '');
  md.push('## Most recent settled picks', '');
  for (const p of recent) {
    md.push(
      `- ${p.result?.toUpperCase()} ${p.matchup}: ${p.pick} — conf ${p.confidence}, ${p.edge_type}, ${p.status}${p.clv !== null ? `, CLV ${p.clv >= 0 ? '+' : ''}${p.clv.toFixed(1)}` : ''}. ${p.thesis.slice(0, 160)}${p.thesis.length > 160 ? '…' : ''}`,
    );
  }
  let narrative: string | null = null;
  if (hasAnthropicKey() && sb.engine.n > 0) {
    try {
      narrative = await runNarrative(md.join('\n'));
    } catch (e) {
      narrative = `(narrative failed: ${(e as Error).message})`;
    }
  }
  const report = md.join('\n');
  const r = db.prepare('INSERT INTO reviews (created_at, label, stats_json, report_md, narrative) VALUES (?, ?, ?, ?, ?)').run(nowIso(), title, JSON.stringify(sb), report, narrative);
  return { id: Number(r.lastInsertRowid), report: narrative ? `${report}\n\n## Engine narrative\n\n${narrative}` : report };
}
