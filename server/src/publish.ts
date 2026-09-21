/**
 * The read-only weekly page: docs/index.html, served by GitHub Pages. Self-contained HTML, no
 * scripts, phone-friendly. `publish()` regenerates it, commits docs/ and pushes when it changed,
 * then pings the friends topic with the link.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, LEAGUE_LABEL } from './config.js';
import { db, logEvent } from './db.js';
import { betLinkFor, fmtLine, fmtPrice } from './odds.js';
import { computeScoreboard, type Bucket } from './stats.js';
import { weekDetail, weekTabs, type SlateGame, type WeekDetail } from './weeks.js';
import { notifyFriends } from './notify.js';

const esc = (s: string | null | undefined) => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (n: number | null) => (n === null ? '–' : `${(n * 100).toFixed(1)}%`);
const units = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${n > 0 ? '+' : ''}${n.toFixed(2)}u`);
const sign = (n: number | null | undefined) => (n === null || n === undefined ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: config.displayTz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const CSS = `
:root{--bg:#0f1410;--bg2:#161d18;--bg3:#1e2821;--bd:#2f4036;--tx:#f3f7f4;--mu:#aebbb2;--ac:#5cc98a;--pos:#2ecc71;--neg:#ff5c5c;--wn:#f5b942;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:16px 16px 60px}h1{font-size:22px;margin:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:var(--mu);margin:0 0 10px}
.muted{color:var(--mu)}.small{font-size:13px}.pos{color:var(--pos)}.neg{color:var(--neg)}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em}
.card{background:var(--bg2);border:1px solid var(--bd);border-radius:10px;padding:14px 16px;margin:12px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.tile .l{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--mu)}.tile .v{font-size:22px;font-weight:600}.tile .s{font-size:12px;color:var(--mu)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;background:var(--bg3);color:var(--mu)}
.badge.win{background:rgba(46,204,113,.22);color:var(--pos)}.badge.loss{background:rgba(255,92,92,.22);color:var(--neg)}.badge.executed{background:rgba(46,204,113,.18);color:var(--pos)}.badge.pending{background:rgba(245,185,66,.2);color:var(--wn)}
.badge.nfl{background:rgba(93,151,255,.2);color:#9cc0ff}.badge.cfb{background:rgba(255,159,67,.2);color:#ffbe7a}
.pick{border:1px solid var(--bd);border-radius:10px;background:var(--bg3);padding:12px 14px;margin:10px 0}.pick .head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pick .name{font-size:17px;font-weight:700}
.bear{margin-top:8px;padding:8px 10px;border-left:3px solid var(--wn);background:rgba(245,185,66,.1);border-radius:6px;font-size:14px}.bear b{color:var(--wn)}
.conf{display:inline-flex;gap:2px;vertical-align:middle}.conf i{width:7px;height:10px;background:var(--bd);border-radius:2px}.conf i.on{background:var(--ac)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 6px;border-bottom:1px solid var(--bd);white-space:nowrap;font-size:13.5px}th{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--mu)}
tr.has-pick td{background:rgba(92,201,138,.08)}.tw{overflow-x:auto}td.wrap{white-space:normal}
details{margin:8px 0}summary{cursor:pointer;font-weight:600}details.week>summary{font-size:16px;padding:8px 0}
.seg{display:inline-flex;border:1px solid var(--bd);border-radius:8px;overflow:hidden;margin-bottom:8px}.seg label{padding:5px 12px;font-size:13px;color:var(--mu);cursor:pointer}
.tabs input{display:none}.tabs .panel{display:none}.tabs input:nth-of-type(1):checked~.seg label:nth-of-type(1),.tabs input:nth-of-type(2):checked~.seg label:nth-of-type(2){background:var(--bg3);color:var(--tx);font-weight:600}
.tabs input:nth-of-type(1):checked~.panel:nth-of-type(1),.tabs input:nth-of-type(2):checked~.panel:nth-of-type(2){display:block}
.note{white-space:normal;color:var(--mu);font-size:13px}a.book{color:var(--ac);font-weight:600;text-decoration:none;border:1px solid var(--bd);border-radius:6px;padding:2px 8px;white-space:nowrap}footer{margin-top:24px;color:var(--mu);font-size:12.5px}
`;

const confBar = (n: number) => `<span class="conf">${Array.from({ length: 10 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;

function tile(label: string, value: string, sub: string, cls = '') {
  return `<div class="card tile"><div class="l">${label}</div><div class="v ${cls}">${value}</div><div class="s">${sub}</div></div>`;
}

function pickHtml(p: WeekDetail['open'][number]) {
  const g = p.game;
  const score = g && g.home_score !== null && (g.status === 'final' || g.status === 'in_progress') ? `${g.away_abbr} ${g.away_score} – ${g.home_score} ${g.home_abbr}${g.status === 'in_progress' ? ' (live)' : ''}` : '';
  return `<div class="pick">
  <div class="head"><span class="badge ${p.league}">${LEAGUE_LABEL[p.league]}</span><span class="name">${esc(p.pick)}</span><span class="muted">${esc(p.matchup)}</span>
    ${p.result ? `<span class="badge ${p.result}">${p.result}</span> <b class="${sign(p.units_net)}">${units(p.units_net)}</b>` : p.status === 'pending' ? '<span class="badge pending">pending</span>' : ''}
    <span class="muted small" style="margin-left:auto">${confBar(p.confidence)} ${p.confidence}/10</span></div>
  <div class="muted small">${when(p.kickoff)} · ${p.units}u · ${esc(p.edge_type.replace('_', ' '))}${score ? ` · <b>${score}</b>` : ''}${p.clv !== null ? ` · CLV <b class="${sign(p.clv)}">${p.clv > 0 ? '+' : ''}${p.clv.toFixed(1)}</b>` : ''}</div>
  <p style="margin:8px 0 0">${esc(p.thesis)}</p>
  <div class="bear"><b>Bear case:</b> ${esc(p.bear_case)}</div>
  ${p.betLink && g && g.status === 'scheduled' && new Date(p.kickoff).getTime() > Date.now() ? `<p class="small" style="margin:8px 0 0"><a class="book" href="${esc(p.betLink)}" target="_blank" rel="noopener noreferrer">Open bet slip at DraftKings ↗</a> <span class="muted">— opens the book with this side selected; the number there may differ.</span></p>` : ''}
</div>`;
}

function spread(g: SlateGame) {
  const l = g.lines;
  if (!l || l.spreadHome === null) return '–';
  if (l.spreadHome === 0) return 'PK';
  return l.spreadHome < 0 ? `${g.home.abbr} ${fmtLine(l.spreadHome)}` : `${g.away.abbr} ${fmtLine(-l.spreadHome)}`;
}
const team = (t: SlateGame['home']) => `${t.rank ? `#${t.rank} ` : ''}${t.abbr}`;

function boardHtml(games: SlateGame[]) {
  if (!games.length) return '<p class="muted">No games.</p>';
  return `<div class="tw"><table><thead><tr><th>Kickoff</th><th>Game</th><th>Spread</th><th>Total</th><th>Lean</th><th>Conf</th><th>Pick</th></tr></thead><tbody>${games
    .map((g) => {
      const fin = g.status === 'final' || g.status === 'in_progress';
      const sc = fin && g.home.score !== null ? ` <span class="muted">${g.away.score}–${g.home.score}</span>` : '';
      const pick = g.proposal ? `<span class="badge ${g.proposal.result ?? g.proposal.status}">${g.proposal.result ?? g.proposal.status}</span> <span class="small">${esc(g.proposal.pick)}</span>` : '';
      const leanLink = g.view && g.status === 'scheduled' && new Date(g.kickoff).getTime() > Date.now() ? leanBetLink(g.view.lean, g) : null;
      const note = g.view?.note || leanLink ? `<tr><td colspan="7" class="note">${esc(g.view?.note ?? '')}${leanLink ? ` <a class="book" href="${esc(leanLink)}" target="_blank" rel="noopener noreferrer">DraftKings ↗</a>` : ''}</td></tr>` : '';
      return `<tr class="${g.proposal ? 'has-pick' : ''}"><td class="muted">${g.status === 'final' ? 'Final' : g.status === 'in_progress' ? 'Live' : when(g.kickoff)}</td><td>${team(g.away)} ${g.neutral ? 'vs' : '@'} ${team(g.home)}${sc}</td><td class="mono">${spread(g)}</td><td class="mono">${g.lines?.total ?? '–'}</td><td>${esc(g.view?.lean ?? '–')}</td><td>${g.view ? `${confBar(g.view.confidence ?? 0)} <span class="muted small">${g.view.confidence}</span>` : '–'}</td><td>${pick}</td></tr>${note}`;
    })
    .join('')}</tbody></table></div>`;
}

/** The bet-slip link for a board lean like "BUF -4.5" / "Under 53.5" / "DET ML". */
function leanBetLink(lean: string, g: SlateGame): string | null {
  const t = lean.trim();
  let m = /^(over|under)\s+[\d.]+$/i.exec(t);
  if (m) return betLinkFor(g.links, 'total', m[1].toLowerCase() as 'over' | 'under');
  m = /^([A-Za-z&\-'.]+)\s+(ML|[+-]?[\d.]+|PK)$/i.exec(t);
  if (!m) return null;
  const abbr = m[1].toUpperCase();
  const side = abbr === g.home.abbr.toUpperCase() ? 'home' : abbr === g.away.abbr.toUpperCase() ? 'away' : null;
  if (!side) return null;
  return betLinkFor(g.links, m[2].toUpperCase() === 'ML' ? 'moneyline' : 'spread', side);
}

function weekHtml(d: WeekDetail, open: boolean) {
  const picks = [...d.pending, ...d.open, ...d.passed, ...d.settled].filter((p) => p.origin !== 'lean');
  const id = d.tab.key;
  const boards = `<div class="tabs">
    <input type="radio" name="b-${id}" id="b-${id}-nfl" ${d.slates.nfl ? 'checked' : ''}><input type="radio" name="b-${id}" id="b-${id}-cfb" ${d.slates.nfl ? '' : 'checked'}>
    <div class="seg">${d.slates.nfl ? `<label for="b-${id}-nfl">NFL</label>` : ''}${d.slates.cfb ? `<label for="b-${id}-cfb">NCAA</label>` : ''}</div>
    <div class="panel">${d.slates.nfl ? boardHtml(d.slates.nfl.games) : ''}</div>
    <div class="panel">${d.slates.cfb ? boardHtml(d.slates.cfb.games) : ''}</div>
  </div>`;
  return `<details class="week" ${open ? 'open' : ''}><summary>${esc(d.tab.label)} <span class="muted small">${esc(d.tab.sublabel)} · ${picks.length} pick${picks.length === 1 ? '' : 's'}</span></summary>
  <div class="card"><h2>Picks</h2>${picks.length ? picks.map(pickHtml).join('') : '<p class="muted">No picks this week.</p>'}</div>
  <div class="card"><h2>Board <span class="muted" style="text-transform:none;letter-spacing:0">— every game, the engine's lean and confidence. Under 5 means no bet; a lean is not a pick.</span></h2>${boards}</div>
</details>`;
}

function bucketRow(label: string, b: Bucket) {
  return `<tr><td>${label}</td><td>${b.wins}-${b.losses}-${b.pushes}</td><td>${pct(b.winRate)}</td><td class="${sign(b.net)}">${units(b.net)}</td><td class="${sign(b.roi)}">${b.roi === null ? '–' : `${b.roi > 0 ? '+' : ''}${(b.roi * 100).toFixed(1)}%`}</td><td class="${sign(b.avgClv)}">${b.avgClv === null ? '–' : `${b.avgClv > 0 ? '+' : ''}${b.avgClv.toFixed(2)}`}</td></tr>`;
}

export async function renderPage(): Promise<string> {
  const sb = computeScoreboard();
  const tabs = await weekTabs();
  const weeks = (await Promise.all([...tabs].reverse().map((t) => weekDetail(t.key)))).filter((d): d is WeekDetail => d !== null);
  const unsettled = weeks.reduce((n, d) => n + [...d.pending, ...d.open, ...d.passed].filter((p) => p.origin !== 'lean').length, 0);
  const label = (k: string) => ({ nfl: 'NFL', cfb: 'College', spread: 'Spread', total: 'Total', moneyline: 'Moneyline' })[k] ?? k.replace('_', ' ');
  const generated = new Date().toLocaleString('en-US', { timeZone: config.displayTz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude Picks</title><style>${CSS}</style></head><body><div class="wrap">
<header><h1>Claude Picks</h1><p class="muted small" style="margin:4px 0 0">A paper-money experiment: can an AI beat the closing line on NFL and college football? Every pick is graded, taken or not. Nothing here is advice; the record below is the whole story. Updated ${generated}.</p></header>
<div class="tiles">
${tile('Engine record', `${sb.engine.wins}-${sb.engine.losses}${sb.engine.pushes ? `-${sb.engine.pushes}` : ''}`, `${pct(sb.engine.winRate)} win · need 52.4% at -110`)}
${tile('Units', units(sb.engine.net), `ROI ${sb.engine.roi === null ? '–' : `${sb.engine.roi > 0 ? '+' : ''}${(sb.engine.roi * 100).toFixed(1)}%`} on ${sb.engine.staked.toFixed(1)}u`, sign(sb.engine.net))}
${tile('Closing line value', sb.engine.avgClv === null ? '–' : `${sb.engine.avgClv > 0 ? '+' : ''}${sb.engine.avgClv.toFixed(2)}`, `avg pts vs close · beat close ${pct(sb.engine.clvBeatRate)}`, sign(sb.engine.avgClv))}
${tile('Unsettled', String(unsettled), 'picks waiting on a final')}
</div>
${weeks.map((d, i) => weekHtml(d, i === 0)).join('\n')}
<div class="card"><h2>Board leans by confidence <span class="muted" style="text-transform:none;letter-spacing:0">— every read graded as 1u at its own line; if the scale means anything, the 5s beat the 3s</span></h2><div class="tw"><table><thead><tr><th></th><th>W-L-P</th><th>Win %</th><th>Units</th><th>ROI</th><th>Avg CLV</th></tr></thead><tbody>
${bucketRow('All leans', sb.leans.all)}
${sb.leans.byConfidence.map((b) => bucketRow(b.label, b.bucket)).join('')}
${bucketRow('Leans at 5+ that were not picks', sb.leans.wouldBePicks)}
</tbody></table></div></div>
<div class="card"><h2>Baselines <span class="muted" style="text-transform:none;letter-spacing:0">— dumb rules on every final game at the closing line; the picks have to beat these, not just 52.4%</span></h2><div class="tw"><table><thead><tr><th></th><th>W-L-P</th><th>Win %</th><th>Units</th><th>ROI</th><th>Avg CLV</th></tr></thead><tbody>
${Object.entries(sb.baselines).map(([k, b]) => bucketRow(k, b)).join('')}
</tbody></table></div></div>
<div class="card"><h2>Season scoreboard (engine picks)</h2><div class="tw"><table><thead><tr><th></th><th>W-L-P</th><th>Win %</th><th>Units</th><th>ROI</th><th>Avg CLV</th></tr></thead><tbody>
${bucketRow('All picks', sb.engine)}
${Object.entries(sb.byLeague).map(([k, b]) => bucketRow(label(k), b)).join('')}
${Object.entries(sb.byMarket).map(([k, b]) => bucketRow(label(k), b)).join('')}
${Object.entries(sb.byEdge).map(([k, b]) => bucketRow(`Edge: ${label(k)}`, b)).join('')}
${Object.entries(sb.byConfidence).map(([k, b]) => bucketRow(`Confidence ${k}`, b)).join('')}
</tbody></table></div>
<p class="muted small">CLV = closing line value: how many points better the pick's number was than where the market closed. Consistently positive CLV is the earliest real evidence of edge; win rate takes hundreds of bets to mean anything.</p></div>
<footer>Paper bets only. Lines are DraftKings via ESPN at proposal time; you will not get the same number. If you bet, that is your decision and your money.</footer>
</div></body></html>`;
}

function unsettledCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE graded_at IS NULL AND status IN ('executed', 'pending', 'passed')`).get() as { n: number }).n;
}

/** Write docs/index.html; commit and push if it changed. Returns true when a new version went out. */
export async function publish(opts: { reason: 'picks' | 'results' | 'manual'; notify?: boolean } = { reason: 'manual' }): Promise<boolean> {
  const docs = path.join(config.repoRoot, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, '.nojekyll'), '');
  const html = await renderPage();
  const file = path.join(docs, 'index.html');
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // Ignore the timestamp when deciding whether anything actually changed.
  const strip = (s: string) => s.replace(/Updated [^<]+\./, '');
  fs.writeFileSync(file, html);
  if (strip(prev) === strip(html)) return false;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: config.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('add', 'docs');
    git('commit', '-q', '-m', `Publish page (${opts.reason})`);
    git('push', '-q');
  } catch (e) {
    logEvent('warn', `Publish: git failed: ${(e as Error).message.split('\n')[0]}`);
    return false;
  }
  logEvent('info', `Published page (${opts.reason})`);
  if (opts.notify && config.pagesUrl) {
    const sb = computeScoreboard();
    const rec = `${sb.engine.wins}-${sb.engine.losses}${sb.engine.pushes ? `-${sb.engine.pushes}` : ''}`;
    if (opts.reason === 'picks') void notifyFriends("This week's picks are up", `Season: ${rec}, ${units(sb.engine.net)}. Picks, reasoning and the board: ${config.pagesUrl}`);
    else if (opts.reason === 'results') void notifyFriends('Weekend results', `Season: ${rec}, ${units(sb.engine.net)}${sb.pending || unsettledCount() ? ' (Monday night still open)' : ''}. ${config.pagesUrl}`);
  }
  return true;
}
