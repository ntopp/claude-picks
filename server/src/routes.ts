import { Router } from 'express';
import { config, hasAnthropicKey, LEAGUES, type League } from './config.js';
import { db, expireStaleProposals, getGame, getProposal, getSettings, listProposals, logEvent, nowIso, updateSettings, type GameRow, type ProposalRow } from './db.js';
import { scoreboard, upcomingWeek } from './espn.js';
import { runApiScan } from './engine/run.js';
import { syncAndGrade } from './grading.js';
import { notifyEnabled } from './notify.js';
import { buildPacket, renderPacketMarkdown } from './slate.js';
import { computeScoreboard } from './stats.js';
import { buildReview } from './review.js';
import { pickedFrom, pickLabel, type Lines } from './odds.js';
import type { Market, Side } from './engine/schema.js';

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
  // A lean bet was never an engine proposal: undoing it removes it entirely and the game returns to the board.
  if (p.origin === 'lean') db.prepare('DELETE FROM proposals WHERE id = ?').run(p.id);
  else db.prepare(`UPDATE proposals SET status = 'pending', executed_units = NULL, decided_at = NULL, decision_note = NULL WHERE id = ?`).run(p.id);
  res.json({ ok: true });
});

api.get('/scoreboard', (_req, res) => res.json(computeScoreboard()));

/** One league-week for the board: every game with lines, score, the engine's view, and any pick on it. */
function slateFor(league: League, season: number, week: number) {
  const rows = db
    .prepare(
      `SELECT g.*, v.lean, v.confidence AS view_confidence, v.note AS view_note, v.updated_at AS view_at,
              p.id AS proposal_id, p.pick AS proposal_pick, p.status AS proposal_status, p.confidence AS proposal_confidence, p.result AS proposal_result, p.origin AS proposal_origin
       FROM games g
       LEFT JOIN game_views v ON v.game_id = g.id
       LEFT JOIN proposals p ON p.game_id = g.id AND p.status != 'void'
       WHERE g.league = ? AND g.season = ? AND g.week = ?
       ORDER BY g.kickoff, g.id`,
    )
    .all(league, season, week) as (GameRow & {
    lean: string | null;
    view_confidence: number | null;
    view_note: string | null;
    view_at: string | null;
    proposal_id: number | null;
    proposal_pick: string | null;
    proposal_status: string | null;
    proposal_confidence: number | null;
    proposal_result: string | null;
    proposal_origin: string | null;
  })[];
  return {
    league,
    season,
    week,
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
      proposal: g.proposal_id
        ? { id: g.proposal_id, pick: g.proposal_pick, status: g.proposal_status, confidence: g.proposal_confidence, result: g.proposal_result, origin: g.proposal_origin }
        : null,
    })),
  };
}

api.get('/slate', async (req, res) => {
  const league = (req.query.league === 'cfb' ? 'cfb' : 'nfl') as League;
  const weeks = await upcomingWeeks();
  const target =
    weeks[league] ??
    (db.prepare('SELECT season, week FROM games WHERE league = ? ORDER BY season DESC, week DESC LIMIT 1').get(league) as { season: number; week: number } | undefined);
  if (!target) return res.json({ league, season: null, week: null, games: [] });
  res.json(slateFor(league, target.season, target.week));
});

// ---- weeks ----------------------------------------------------------------
// An experiment week is an NFL week (Wed -> Tue per ESPN's calendar); the college week whose games fall
// inside that window rides along (CFB week 3 with NFL week 2 in 2026). College-only weeks before the
// NFL starts get their own tab.

let calendarCache: { at: number; value: { week: number; start: string; end: string }[] } | null = null;
async function nflCalendar() {
  if (calendarCache && Date.now() - calendarCache.at < 6 * 3600_000) return calendarCache.value;
  try {
    const sb = await scoreboard('nfl');
    calendarCache = { at: Date.now(), value: sb.weeks };
  } catch {
    calendarCache = calendarCache ?? { at: 0, value: [] };
  }
  return calendarCache.value;
}

export type WeekTab = {
  key: string; // "2026-w02" or "2026-c01"
  label: string;
  sublabel: string;
  season: number;
  nfl: { season: number; week: number } | null;
  cfb: { season: number; week: number } | null;
  start: string;
  end: string;
  current: boolean;
  picks: number;
  pending: number;
};

async function weekTabs(): Promise<WeekTab[]> {
  const cal = await nflCalendar();
  const upcoming = await upcomingWeeks();
  const rows = db
    .prepare('SELECT league, season, week, MIN(kickoff) AS first, MAX(kickoff) AS last FROM games GROUP BY league, season, week ORDER BY season, first')
    .all() as { league: League; season: number; week: number; first: string; last: string }[];
  const tabs = new Map<string, WeekTab>();
  const pad = (w: number) => String(w).padStart(2, '0');
  for (const r of rows.filter((r) => r.league === 'nfl')) {
    const win = cal.find((c) => c.week === r.week);
    const key = `${r.season}-w${pad(r.week)}`;
    tabs.set(key, {
      key,
      label: `Week ${r.week}`,
      sublabel: `NFL ${r.week}`,
      season: r.season,
      nfl: { season: r.season, week: r.week },
      cfb: null,
      start: win?.start ?? r.first,
      end: win?.end ?? r.last,
      current: upcoming.nfl?.week === r.week && upcoming.nfl?.season === r.season,
      picks: 0,
      pending: 0,
    });
  }
  for (const r of rows.filter((r) => r.league === 'cfb')) {
    // Attach to the NFL week whose window contains the college week's first kickoff.
    const host = [...tabs.values()].find((t) => t.nfl && r.first >= t.start && r.first < t.end);
    if (host) {
      host.cfb = { season: r.season, week: r.week };
      host.sublabel = `NFL ${host.nfl!.week} · CFB ${r.week}`;
    } else {
      const key = `${r.season}-c${pad(r.week)}`;
      tabs.set(key, {
        key,
        label: `CFB wk ${r.week}`,
        sublabel: `CFB ${r.week}`,
        season: r.season,
        nfl: null,
        cfb: { season: r.season, week: r.week },
        start: r.first,
        end: r.last,
        current: !upcoming.nfl && upcoming.cfb?.week === r.week && upcoming.cfb?.season === r.season,
        picks: 0,
        pending: 0,
      });
    }
  }
  const counts = db
    .prepare(`SELECT league, season, week, COUNT(*) AS n, SUM(status = 'pending') AS pending FROM proposals WHERE status != 'void' GROUP BY league, season, week`)
    .all() as { league: League; season: number; week: number; n: number; pending: number }[];
  for (const t of tabs.values()) {
    for (const c of counts) {
      const match = (t.nfl && c.league === 'nfl' && c.season === t.nfl.season && c.week === t.nfl.week) || (t.cfb && c.league === 'cfb' && c.season === t.cfb.season && c.week === t.cfb.week);
      if (match) {
        t.picks += c.n;
        t.pending += c.pending;
      }
    }
  }
  // Weeks that came and went with no picks (e.g. before the experiment started) are noise; keep current and future ones.
  const now = nowIso();
  const list = [...tabs.values()].filter((t) => t.picks > 0 || t.current || t.start > now).sort((a, b) => a.start.localeCompare(b.start));
  if (!list.some((t) => t.current) && list.length) list[list.length - 1].current = true;
  return list;
}

api.get('/weeks', async (_req, res, next) => {
  try {
    res.json(await weekTabs());
  } catch (e) {
    next(e);
  }
});

/** Everything for one week tab: picks by status and both boards. */
api.get('/week/:key', async (req, res, next) => {
  try {
    expireStaleProposals();
    const tab = (await weekTabs()).find((t) => t.key === req.params.key);
    if (!tab) return res.status(404).json({ error: 'No such week' });
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (tab.nfl) {
      clauses.push('(league = ? AND season = ? AND week = ?)');
      params.push('nfl', tab.nfl.season, tab.nfl.week);
    }
    if (tab.cfb) {
      clauses.push('(league = ? AND season = ? AND week = ?)');
      params.push('cfb', tab.cfb.season, tab.cfb.week);
    }
    const all = (db.prepare(`SELECT * FROM proposals WHERE status != 'void' AND (${clauses.join(' OR ')}) ORDER BY kickoff, id`).all(...params) as ProposalRow[]).map(withGame);
    res.json({
      tab,
      pending: all.filter((p) => p.status === 'pending'),
      open: all.filter((p) => p.status === 'executed' && !p.graded_at),
      passed: all.filter((p) => p.status === 'passed' && !p.graded_at),
      settled: all.filter((p) => !!p.graded_at).sort((a, b) => b.kickoff.localeCompare(a.kickoff)),
      slates: {
        nfl: tab.nfl ? slateFor('nfl', tab.nfl.season, tab.nfl.week) : null,
        cfb: tab.cfb ? slateFor('cfb', tab.cfb.season, tab.cfb.week) : null,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Bet a board lean yourself. Parses the engine's lean ("BUF -4.5", "Under 53.5", "DET ML") into a
 * market/side and logs it at the CURRENT line and price, tagged origin=lean so the engine is not
 * scored on it.
 */
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
