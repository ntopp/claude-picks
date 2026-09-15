import { Router } from 'express';
import { config, hasAnthropicKey, LEAGUES, type League } from './config.js';
import { db, expireStaleProposals, getGame, getProposal, getSettings, listProposals, logEvent, nowIso, updateSettings, type GameRow, type ProposalRow } from './db.js';
import { upcomingWeek } from './espn.js';
import { runApiScan } from './engine/run.js';
import { syncAndGrade } from './grading.js';
import { notifyEnabled } from './notify.js';
import { buildPacket, renderPacketMarkdown } from './slate.js';
import { computeScoreboard } from './stats.js';
import { buildReview } from './review.js';
import { pickedFrom, type Lines } from './odds.js';

export const api = Router();

// Upcoming week per league, cached for an hour so /status stays cheap.
let weekCache: { at: number; value: Record<League, { season: number; week: number } | null> } | null = null;
async function upcomingWeeks() {
  if (weekCache && Date.now() - weekCache.at < 3600_000) return weekCache.value;
  const value = { nfl: null, cfb: null } as Record<League, { season: number; week: number } | null>;
  await Promise.all(
    LEAGUES.map(async (l) => {
      try {
        value[l] = await upcomingWeek(l);
      } catch {
        value[l] = null;
      }
    }),
  );
  weekCache = { at: Date.now(), value };
  return value;
}

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

/** A proposal plus the game's current state (score, current line for the picked side). */
function withGame(p: ProposalRow) {
  const g = getGame(p.game_id);
  const lines: Lines | null = g?.lines_json ? (JSON.parse(g.lines_json) as Lines) : null;
  const now = lines ? pickedFrom(lines, p.market, p.side) : null;
  return {
    ...p,
    key_factors: p.key_factors_json ? (JSON.parse(p.key_factors_json) as string[]) : [],
    game: g
      ? { status: g.status, home_abbr: g.home_abbr, away_abbr: g.away_abbr, home_score: g.home_score, away_score: g.away_score, home_rank: g.home_rank, away_rank: g.away_rank, neutral: !!g.neutral, lines_updated_at: g.lines_updated_at }
      : null,
    currentLine: now?.line ?? null,
    currentPrice: now?.price ?? null,
  };
}

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
  db.prepare(`UPDATE proposals SET status = 'pending', executed_units = NULL, decided_at = NULL, decision_note = NULL WHERE id = ?`).run(p.id);
  res.json({ ok: true });
});

api.get('/scoreboard', (_req, res) => res.json(computeScoreboard()));

/** This week's board for one league: every game with lines, score, the engine's view, and any pick on it. */
api.get('/slate', async (req, res) => {
  const league = (req.query.league === 'cfb' ? 'cfb' : 'nfl') as League;
  const weeks = await upcomingWeeks();
  const target =
    weeks[league] ??
    (db.prepare('SELECT season, week FROM games WHERE league = ? ORDER BY season DESC, week DESC LIMIT 1').get(league) as { season: number; week: number } | undefined);
  if (!target) return res.json({ league, season: null, week: null, games: [] });
  const rows = db
    .prepare(
      `SELECT g.*, v.lean, v.confidence AS view_confidence, v.note AS view_note, v.updated_at AS view_at,
              p.id AS proposal_id, p.pick AS proposal_pick, p.status AS proposal_status, p.confidence AS proposal_confidence, p.result AS proposal_result
       FROM games g
       LEFT JOIN game_views v ON v.game_id = g.id
       LEFT JOIN proposals p ON p.game_id = g.id AND p.status != 'void'
       WHERE g.league = ? AND g.season = ? AND g.week = ?
       ORDER BY g.kickoff, g.id`,
    )
    .all(league, target.season, target.week) as (GameRow & {
    lean: string | null;
    view_confidence: number | null;
    view_note: string | null;
    view_at: string | null;
    proposal_id: number | null;
    proposal_pick: string | null;
    proposal_status: string | null;
    proposal_confidence: number | null;
    proposal_result: string | null;
  })[];
  res.json({
    league,
    season: target.season,
    week: target.week,
    games: rows.map((g) => ({
      id: g.id,
      kickoff: g.kickoff,
      name: g.name,
      home: { abbr: g.home_abbr, name: g.home_name, rank: g.home_rank, score: g.home_score },
      away: { abbr: g.away_abbr, name: g.away_name, rank: g.away_rank, score: g.away_score },
      neutral: !!g.neutral,
      status: g.status,
      lines: g.lines_json ? (JSON.parse(g.lines_json) as Lines) : null,
      open: g.lines_open_json ? (JSON.parse(g.lines_open_json) as Lines) : null,
      view: g.lean ? { lean: g.lean, confidence: g.view_confidence, note: g.view_note, at: g.view_at } : null,
      proposal: g.proposal_id ? { id: g.proposal_id, pick: g.proposal_pick, status: g.proposal_status, confidence: g.proposal_confidence, result: g.proposal_result } : null,
    })),
  });
});

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
