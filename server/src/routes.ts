import { Router } from 'express';
import { config, hasAnthropicKey, LEAGUES, type League } from './config.js';
import { db, expireStaleProposals, getGame, getProposal, getSettings, listProposals, logEvent, nowIso, updateSettings, type GameRow, type ProposalRow } from './db.js';
import { runApiScan } from './engine/run.js';
import { syncAndGrade } from './grading.js';
import { notifyEnabled } from './notify.js';
import { buildPacket, renderPacketMarkdown } from './slate.js';
import { computeScoreboard } from './stats.js';
import { buildReview } from './review.js';
import { pickedFrom, pickLabel, type Lines } from './odds.js';
import { slateFor, upcomingWeeks, weekDetail, weekTabs, withGame } from './weeks.js';
import type { Market, Side } from './engine/schema.js';

export const api = Router();

let scanRunning = false;

api.get('/status', async (_req, res) => {
  expireStaleProposals();
  res.json({
    anthropicConfigured: hasAnthropicKey(),
    model: config.anthropic.model,
    displayTz: config.displayTz,
    notifications: notifyEnabled(),
    settings: getSettings(),
    upcoming: await upcomingWeeks(),
    scanRunning,
    pending: (db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'`).get() as { n: number }).n,
  });
});

api.get('/dashboard', (_req, res) => {
  expireStaleProposals();
  const pending = listProposals({ status: 'pending' }).map(withGame);
  const live = (db.prepare(`SELECT * FROM proposals WHERE status = 'executed' AND graded_at IS NULL ORDER BY kickoff`).all() as ProposalRow[]).map(withGame);
  const passed = (db.prepare(`SELECT * FROM proposals WHERE status = 'passed' AND graded_at IS NULL ORDER BY kickoff`).all() as ProposalRow[]).map(withGame);
  const recent = (db.prepare(`SELECT * FROM proposals WHERE graded_at IS NOT NULL AND status != 'void' ORDER BY kickoff DESC LIMIT 12`).all() as ProposalRow[]).map(withGame);
  const sb = computeScoreboard();
  res.json({ pending, live, passed, recent, scoreboard: { engine: sb.engine, human: sb.human, bankroll: sb.bankroll, breakEven: sb.breakEven, unitDollars: sb.unitDollars }, settings: getSettings() });
});

api.get('/proposals', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const graded = req.query.graded === 'true' ? true : req.query.graded === 'false' ? false : undefined;
  res.json(listProposals({ status, graded, limit: 1000 }).map(withGame));
});

api.post('/proposals/:id/execute', (req, res) => {
  const p = getProposal(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'No such proposal' });
  if (p.status !== 'pending') return res.status(400).json({ error: `Proposal is ${p.status}` });
  if (new Date(p.kickoff).getTime() < Date.now()) return res.status(400).json({ error: 'Game already kicked off' });
  const s = getSettings();
  const body = (req.body ?? {}) as { units?: number; note?: string };
  const units = Number(body.units ?? p.units);
  if (!Number.isFinite(units) || units <= 0) return res.status(400).json({ error: 'units must be positive' });
  if (units > s.maxUnitsPerBet) return res.status(400).json({ error: `units above the ${s.maxUnitsPerBet}u cap (change it in Settings)` });
  db.prepare(`UPDATE proposals SET status = 'executed', executed_units = ?, decided_at = ?, decision_note = ? WHERE id = ?`).run(units, nowIso(), body.note ?? null, p.id);
  logEvent('info', `Executed ${p.matchup}: ${p.pick} for ${units}u`);
  res.json({ ok: true });
});

api.post('/proposals/:id/pass', (req, res) => {
  const p = getProposal(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'No such proposal' });
  if (p.status !== 'pending') return res.status(400).json({ error: `Proposal is ${p.status}` });
  const body = (req.body ?? {}) as { note?: string };
  db.prepare(`UPDATE proposals SET status = 'passed', decided_at = ?, decision_note = ? WHERE id = ?`).run(nowIso(), body.note ?? null, p.id);
  logEvent('info', `Passed ${p.matchup}: ${p.pick}${body.note ? ` — ${body.note}` : ''}`);
  res.json({ ok: true });
});

/** Change your mind before kickoff: back to pending. */
api.post('/proposals/:id/undo', (req, res) => {
  const p = getProposal(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'No such proposal' });
  if (p.status !== 'executed' && p.status !== 'passed') return res.status(400).json({ error: `Proposal is ${p.status}` });
  if (new Date(p.kickoff).getTime() < Date.now()) return res.status(400).json({ error: 'Game already kicked off' });
  // A lean bet was never an engine proposal: undoing it removes it entirely and the game returns to the board.
  if (p.origin === 'lean') db.prepare('DELETE FROM proposals WHERE id = ?').run(p.id);
  else db.prepare(`UPDATE proposals SET status = 'pending', executed_units = NULL, decided_at = NULL, decision_note = NULL WHERE id = ?`).run(p.id);
  res.json({ ok: true });
});

api.get('/scoreboard', (_req, res) => res.json(computeScoreboard()));

api.get('/slate', async (req, res) => {
  const league = (req.query.league === 'cfb' ? 'cfb' : 'nfl') as League;
  const weeks = await upcomingWeeks();
  const target =
    weeks[league] ??
    (db.prepare('SELECT season, week FROM games WHERE league = ? ORDER BY season DESC, week DESC LIMIT 1').get(league) as { season: number; week: number } | undefined);
  if (!target) return res.json({ league, season: null, week: null, games: [] });
  res.json(slateFor(league, target.season, target.week));
});

api.get('/weeks', async (_req, res, next) => {
  try {
    res.json(await weekTabs());
  } catch (e) {
    next(e);
  }
});

/** Everything for one week tab: picks by status and both boards. */
/** Everything for one week tab: picks by status and both boards. */
api.get('/week/:key', async (req, res, next) => {
  try {
    const d = await weekDetail(req.params.key);
    if (!d) return res.status(404).json({ error: 'No such week' });
    res.json(d);
  } catch (e) {
    next(e);
  }
});


api.post('/board/:gameId/execute', (req, res) => {
  const g = getGame(req.params.gameId);
  if (!g) return res.status(404).json({ error: 'No such game' });
  if (g.status !== 'scheduled' || new Date(g.kickoff).getTime() < Date.now()) return res.status(400).json({ error: 'Game already kicked off' });
  const view = db.prepare('SELECT * FROM game_views WHERE game_id = ?').get(g.id) as { run_id: number | null; lean: string; confidence: number; note: string } | undefined;
  if (!view) return res.status(400).json({ error: 'No lean on this game' });
  if (db.prepare(`SELECT id FROM proposals WHERE game_id = ? AND status != 'void'`).get(g.id)) return res.status(400).json({ error: 'There is already a pick on this game' });
  const lines: Lines | null = g.lines_json ? (JSON.parse(g.lines_json) as Lines) : null;
  if (!lines) return res.status(400).json({ error: 'No current line for this game' });
  const parsed = parseLean(view.lean, g);
  if (!parsed) return res.status(400).json({ error: `Cannot turn "${view.lean}" into a bet` });
  const cur = pickedFrom(lines, parsed.market, parsed.side);
  if (parsed.market !== 'moneyline' && cur.line === null) return res.status(400).json({ error: 'No current line for that market' });
  const price = cur.price ?? -110;
  const s = getSettings();
  const body = (req.body ?? {}) as { units?: number; note?: string };
  const units = Number(body.units ?? s.defaultUnits);
  if (!Number.isFinite(units) || units <= 0) return res.status(400).json({ error: 'units must be positive' });
  if (units > s.maxUnitsPerBet) return res.status(400).json({ error: `units above the ${s.maxUnitsPerBet}u cap (change it in Settings)` });
  const label = pickLabel(parsed.market, parsed.side, cur.line, price, g.home_abbr, g.away_abbr);
  const r = db
    .prepare(
      `INSERT INTO proposals (run_id, created_at, expires_at, game_id, league, season, week, kickoff, matchup, market, side, pick, line, price, units, confidence, edge_type, thesis, bear_case, key_factors_json, lines_at_proposal_json, status, origin, decided_at, decision_note, executed_units)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'other', ?, ?, '[]', ?, 'executed', 'lean', ?, ?, ?)`,
    )
    .run(
      view.run_id, nowIso(), g.kickoff, g.id, g.league, g.season, g.week, g.kickoff, g.name,
      parsed.market, parsed.side, label, cur.line, price, units, view.confidence,
      view.note || 'Board lean taken by the user.', 'User-executed board lean; the engine did not propose this as a pick.',
      JSON.stringify(lines), nowIso(), body.note ?? null, units,
    );
  logEvent('info', `Executed board lean ${g.name}: ${label} for ${units}u`);
  res.json({ ok: true, id: Number(r.lastInsertRowid), pick: label });
});

function parseLean(lean: string, g: GameRow): { market: Market; side: Side } | null {
  const t = lean.trim();
  let m = /^(over|under)\s+[\d.]+$/i.exec(t);
  if (m) return { market: 'total', side: m[1].toLowerCase() as Side };
  m = /^([A-Za-z&\-'.]+)\s+ML$/i.exec(t);
  if (m) {
    const side = teamSide(m[1], g);
    return side ? { market: 'moneyline', side } : null;
  }
  m = /^([A-Za-z&\-'.]+)\s+([+-]?[\d.]+|PK)$/i.exec(t);
  if (m) {
    const side = teamSide(m[1], g);
    return side ? { market: 'spread', side } : null;
  }
  return null;
}

function teamSide(abbr: string, g: GameRow): 'home' | 'away' | null {
  const a = abbr.toUpperCase();
  if (a === g.home_abbr.toUpperCase()) return 'home';
  if (a === g.away_abbr.toUpperCase()) return 'away';
  return null;
}

api.get('/games', (req, res) => {
  const league = String(req.query.league ?? 'nfl');
  const season = Number(req.query.season);
  const week = Number(req.query.week);
  if (!season || !week) return res.status(400).json({ error: 'season and week required' });
  const rows = db.prepare('SELECT * FROM games WHERE league = ? AND season = ? AND week = ? ORDER BY kickoff').all(league, season, week) as GameRow[];
  res.json(
    rows.map((g) => ({
      ...g,
      lines: g.lines_json ? JSON.parse(g.lines_json) : null,
      open: g.lines_open_json ? JSON.parse(g.lines_open_json) : null,
      closing: g.lines_closing_json ? JSON.parse(g.lines_closing_json) : null,
    })),
  );
});

api.get('/runs', (_req, res) => {
  res.json(db.prepare('SELECT id, started_at, finished_at, kind, engine, leagues, week_label, summary, error, input_tokens, output_tokens FROM runs ORDER BY id DESC LIMIT 100').all());
});

api.get('/runs/:id', (req, res) => {
  const run = db.prepare('SELECT id, started_at, finished_at, kind, engine, leagues, week_label, summary, response_json, error, input_tokens, output_tokens FROM runs WHERE id = ?').get(Number(req.params.id)) as
    | { response_json: string | null }
    | undefined;
  if (!run) return res.status(404).json({ error: 'No such run' });
  const proposals = (db.prepare('SELECT * FROM proposals WHERE run_id = ? ORDER BY confidence DESC').all(Number(req.params.id)) as ProposalRow[]).map(withGame);
  res.json({ ...run, response: run.response_json ? JSON.parse(run.response_json) : null, response_json: undefined, proposals });
});

api.post('/scan', (req, res) => {
  if (!hasAnthropicKey()) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set. Run the analysis from a Claude Code session: npm run packet → npm run propose.' });
  if (scanRunning) return res.status(409).json({ error: 'A scan is already running' });
  const body = (req.body ?? {}) as { note?: string; leagues?: League[] };
  scanRunning = true;
  logEvent('info', `API scan started (${(body.leagues ?? LEAGUES).join(', ')})`);
  void runApiScan('adhoc', { userNote: body.note, leagues: body.leagues })
    .catch(() => undefined)
    .finally(() => {
      scanRunning = false;
    });
  res.json({ started: true });
});

api.post('/grade', async (_req, res, next) => {
  try {
    res.json(await syncAndGrade());
  } catch (e) {
    next(e);
  }
});

api.post('/packet', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { leagues?: League[]; noDetail?: boolean };
    const packet = await buildPacket({ leagues: body.leagues, noDetail: body.noDetail });
    res.json({ markdown: renderPacketMarkdown(packet, config.displayTz), games: packet.leagues.reduce((a, l) => a + l.games.length, 0) });
  } catch (e) {
    next(e);
  }
});

api.get('/settings', (_req, res) => res.json(getSettings()));
api.put('/settings', (req, res) => res.json(updateSettings((req.body ?? {}) as Partial<ReturnType<typeof getSettings>>)));

api.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 60), 500);
  res.json(db.prepare('SELECT id, ts, level, message FROM events ORDER BY id DESC LIMIT ?').all(limit));
});

api.get('/reviews', (_req, res) => res.json(db.prepare('SELECT id, created_at, label, report_md, narrative FROM reviews ORDER BY id DESC LIMIT 50').all()));
api.post('/reviews/run', async (_req, res, next) => {
  try {
    res.json(await buildReview());
  } catch (e) {
    next(e);
  }
});
