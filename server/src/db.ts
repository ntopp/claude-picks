import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config, DEFAULT_SETTINGS, type Settings } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'picks.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000'); // the CLI scripts and the server share this file; wait for locks instead of throwing

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per ESPN event we have ever put in a packet or bet on. Lines are snapshots:
-- open = the book's opener, current = last seen while still scheduled, closing = frozen at kickoff.
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  league TEXT NOT NULL,           -- nfl | cfb
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  kickoff TEXT NOT NULL,
  name TEXT NOT NULL,             -- "DET @ BUF"
  home_id TEXT, home_abbr TEXT NOT NULL, home_name TEXT NOT NULL, home_rank INTEGER,
  away_id TEXT, away_abbr TEXT NOT NULL, away_name TEXT NOT NULL, away_rank INTEGER,
  neutral INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,           -- scheduled | in_progress | final | postponed | canceled
  home_score INTEGER,
  away_score INTEGER,
  lines_open_json TEXT,
  lines_json TEXT,
  lines_closing_json TEXT,
  lines_updated_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_week ON games(league, season, week);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  kind TEXT NOT NULL,             -- weekly | adhoc
  engine TEXT NOT NULL,           -- api | session
  leagues TEXT NOT NULL,          -- "nfl,cfb"
  week_label TEXT,                -- "NFL wk 2 / CFB wk 3"
  summary TEXT,
  packet_json TEXT,
  response_json TEXT,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,       -- kickoff: you cannot execute after the game starts
  game_id TEXT NOT NULL REFERENCES games(id),
  league TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  kickoff TEXT NOT NULL,
  matchup TEXT NOT NULL,
  market TEXT NOT NULL,           -- spread | total | moneyline
  side TEXT NOT NULL,             -- home | away | over | under
  pick TEXT NOT NULL,             -- display label, e.g. "BUF -4.5 (-110)"
  line REAL,                      -- picked side's number (spread from its perspective; the total)
  price INTEGER NOT NULL,         -- American odds at proposal time
  units REAL NOT NULL,            -- engine's suggested stake
  confidence INTEGER NOT NULL,    -- 1-10
  edge_type TEXT NOT NULL,
  thesis TEXT NOT NULL,
  bear_case TEXT NOT NULL,
  key_factors_json TEXT,
  lines_at_proposal_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | executed | passed | expired | void
  decided_at TEXT,
  decision_note TEXT,
  executed_units REAL,
  result TEXT,                    -- win | loss | push
  cover_margin REAL,
  units_net REAL,                 -- at the proposed stake
  closing_line REAL,
  closing_price INTEGER,
  clv REAL,
  graded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_game ON proposals(game_id);

-- Every distinct line we have seen for a game, so open -> Monday -> midweek -> close is reconstructible.
CREATE TABLE IF NOT EXISTS line_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id),
  ts TEXT NOT NULL,
  lines_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_game ON line_snapshots(game_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  label TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  report_md TEXT NOT NULL,
  narrative TEXT
);
`);

export const nowIso = () => new Date().toISOString();

export function logEvent(level: 'info' | 'warn' | 'error', message: string, data?: unknown) {
  db.prepare('INSERT INTO events (ts, level, message, data_json) VALUES (?, ?, ?, ?)').run(
    nowIso(),
    level,
    message,
    data === undefined ? null : JSON.stringify(data),
  );
  const line = `[${level}] ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

// ---- settings -------------------------------------------------------------

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) out[r.key] = JSON.parse(r.value);
  }
  return out as Settings;
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function updateSettings(patch: Partial<Settings>) {
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULT_SETTINGS) setSetting(k as keyof Settings, v as never);
  }
  return getSettings();
}

// ---- rows -----------------------------------------------------------------

export type GameRow = {
  id: string;
  league: 'nfl' | 'cfb';
  season: number;
  week: number;
  kickoff: string;
  name: string;
  home_id: string | null;
  home_abbr: string;
  home_name: string;
  home_rank: number | null;
  away_id: string | null;
  away_abbr: string;
  away_name: string;
  away_rank: number | null;
  neutral: number;
  status: 'scheduled' | 'in_progress' | 'final' | 'postponed' | 'canceled';
  home_score: number | null;
  away_score: number | null;
  lines_open_json: string | null;
  lines_json: string | null;
  lines_closing_json: string | null;
  lines_updated_at: string | null;
  updated_at: string;
};

export type ProposalRow = {
  id: number;
  run_id: number | null;
  created_at: string;
  expires_at: string;
  game_id: string;
  league: 'nfl' | 'cfb';
  season: number;
  week: number;
  kickoff: string;
  matchup: string;
  market: 'spread' | 'total' | 'moneyline';
  side: 'home' | 'away' | 'over' | 'under';
  pick: string;
  line: number | null;
  price: number;
  units: number;
  confidence: number;
  edge_type: string;
  thesis: string;
  bear_case: string;
  key_factors_json: string | null;
  lines_at_proposal_json: string | null;
  status: 'pending' | 'executed' | 'passed' | 'expired' | 'void';
  decided_at: string | null;
  decision_note: string | null;
  executed_units: number | null;
  result: 'win' | 'loss' | 'push' | null;
  cover_margin: number | null;
  units_net: number | null;
  closing_line: number | null;
  closing_price: number | null;
  clv: number | null;
  graded_at: string | null;
};

export function expireStaleProposals() {
  const r = db.prepare(`UPDATE proposals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at < ?`).run(nowIso(), nowIso());
  if (r.changes > 0) logEvent('info', `Expired ${r.changes} proposal(s) at kickoff`);
}

export function listProposals(opts: { status?: string; limit?: number; graded?: boolean } = {}): ProposalRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.graded === true) where.push('graded_at IS NOT NULL');
  if (opts.graded === false) where.push('graded_at IS NULL');
  const sql = `SELECT * FROM proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY kickoff ASC, created_at DESC LIMIT ?`;
  return db.prepare(sql).all(...params, opts.limit ?? 500) as ProposalRow[];
}

export function getProposal(id: number): ProposalRow | undefined {
  return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
}

export function getGame(id: string): GameRow | undefined {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
}

export function listGames(league: string, season: number, week: number): GameRow[] {
  return db.prepare('SELECT * FROM games WHERE league = ? AND season = ? AND week = ? ORDER BY kickoff').all(league, season, week) as GameRow[];
}
