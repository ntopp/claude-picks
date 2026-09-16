/**
 * Experiment weeks: an NFL week (Wed -> Tue per ESPN's calendar) plus the college week whose games fall
 * inside that window. Shared by the dashboard API and the static publisher.
 */
import { LEAGUES, type League } from './config.js';
import { db, expireStaleProposals, getGame, nowIso, type GameRow, type ProposalRow } from './db.js';
import { scoreboard, upcomingWeek } from './espn.js';
import { pickedFrom, type Lines } from './odds.js';

// Upcoming week per league, cached for an hour so /status stays cheap.
let weekCache: { at: number; value: Record<League, { season: number; week: number } | null> } | null = null;
export async function upcomingWeeks() {
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

/** A proposal plus the game's current state (score, current line for the picked side). */
export function withGame(p: ProposalRow) {
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

/** One league-week for the board: every game with lines, score, the engine's view, and any pick on it. */
export function slateFor(league: League, season: number, week: number) {
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

export async function weekTabs(): Promise<WeekTab[]> {
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


/** Everything for one week tab: picks by status and both boards. */
export async function weekDetail(key: string) {
  expireStaleProposals();
  const tab = (await weekTabs()).find((t) => t.key === key);
  if (!tab) return null;
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
  return {
    tab,
    pending: all.filter((p) => p.status === 'pending'),
    open: all.filter((p) => p.status === 'executed' && !p.graded_at),
    passed: all.filter((p) => p.status === 'passed' && !p.graded_at),
    settled: all.filter((p) => !!p.graded_at).sort((a, b) => b.kickoff.localeCompare(a.kickoff)),
    slates: {
      nfl: tab.nfl ? slateFor('nfl', tab.nfl.season, tab.nfl.week) : null,
      cfb: tab.cfb ? slateFor('cfb', tab.cfb.season, tab.cfb.week) : null,
    },
  };
}
export type WeekDetail = NonNullable<Awaited<ReturnType<typeof weekDetail>>>;
export type SlateGame = ReturnType<typeof slateFor>['games'][number];
