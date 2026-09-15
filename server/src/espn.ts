/**
 * ESPN's public site API. No key. Scoreboard = schedule + scores + DraftKings lines + weather;
 * summary = per-game injuries, last five results, FPI projection, multi-book lines.
 */
import type { League } from './config.js';
import type { Lines } from './odds.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football';
const PATH: Record<League, string> = { nfl: 'nfl', cfb: 'college-football' };

async function getJson<T>(url: string, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'claude-picks/0.1 (paper experiment)' } });
      if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---- raw shapes (only the fields we read) ---------------------------------

type RawTeam = { id: string; abbreviation: string; displayName: string; shortDisplayName?: string };
type RawCompetitor = {
  homeAway: 'home' | 'away';
  team: RawTeam;
  score?: string;
  curatedRank?: { current?: number };
  records?: { type: string; summary: string }[];
};
type RawPrice = { line?: string; odds?: string };
type RawOdds = {
  provider: { name: string };
  details?: string;
  overUnder?: number;
  spread?: number;
  pointSpread?: { home?: { close?: RawPrice; open?: RawPrice }; away?: { close?: RawPrice; open?: RawPrice } };
  total?: { over?: { close?: RawPrice; open?: RawPrice }; under?: { close?: RawPrice; open?: RawPrice } };
  moneyline?: { home?: { close?: RawPrice; open?: RawPrice }; away?: { close?: RawPrice; open?: RawPrice } };
};
type RawEvent = {
  id: string;
  date: string;
  name: string;
  shortName: string;
  season: { year: number; type: number };
  week: { number: number };
  weather?: { displayValue?: string; temperature?: number; conditionId?: string };
  competitions: {
    neutralSite?: boolean;
    conferenceCompetition?: boolean;
    venue?: { fullName?: string; indoor?: boolean; address?: { city?: string; state?: string } };
    competitors: RawCompetitor[];
    status: { type: { name: string; completed: boolean; state: 'pre' | 'in' | 'post'; detail?: string } };
    odds?: RawOdds[];
    broadcasts?: { names?: string[] }[];
  }[];
};
type RawScoreboard = {
  season: { type: number; year: number };
  week: { number: number };
  leagues: { calendar?: { label: string; value: string; entries?: { label: string; value: string; startDate: string; endDate: string }[] }[] }[];
  events: RawEvent[];
};

// ---- normalized shapes ----------------------------------------------------

export type GameStatus = 'scheduled' | 'in_progress' | 'final' | 'postponed' | 'canceled';

export type ScoreboardGame = {
  id: string;
  league: League;
  season: number;
  week: number;
  kickoff: string;
  name: string; // "DET @ BUF" or "SYR vs PITT" when neutral
  status: GameStatus;
  statusDetail: string;
  neutral: boolean;
  conferenceGame: boolean;
  venue: string;
  indoor: boolean;
  weather: string | null;
  tv: string | null;
  home: { id: string; abbr: string; name: string; record: string; rank: number | null; score: number | null };
  away: { id: string; abbr: string; name: string; record: string; rank: number | null; score: number | null };
  lines: Lines | null;
  open: Lines | null;
};

const num = (s: string | number | undefined | null): number | null => {
  if (s === undefined || s === null || s === '') return null;
  const n = typeof s === 'number' ? s : Number(String(s).replace(/^[ou]/i, '').replace('EVEN', '100').replace('PK', '0'));
  return Number.isFinite(n) ? n : null;
};

function parseLines(o: RawOdds | undefined, which: 'close' | 'open'): Lines | null {
  if (!o) return null;
  const ps = o.pointSpread;
  const tot = o.total;
  const ml = o.moneyline;
  const spreadHome = num(ps?.home?.[which]?.line) ?? (which === 'close' ? num(o.spread) : null);
  const total = num(tot?.over?.[which]?.line) ?? (which === 'close' ? num(o.overUnder) : null);
  const lines: Lines = {
    provider: o.provider?.name ?? 'unknown',
    spreadHome,
    spreadHomePrice: num(ps?.home?.[which]?.odds),
    spreadAwayPrice: num(ps?.away?.[which]?.odds),
    total,
    overPrice: num(tot?.over?.[which]?.odds),
    underPrice: num(tot?.under?.[which]?.odds),
    mlHome: num(ml?.home?.[which]?.odds),
    mlAway: num(ml?.away?.[which]?.odds),
  };
  if (lines.spreadHome === null && lines.total === null && lines.mlHome === null) return null;
  return lines;
}

function statusOf(name: string, state: string): GameStatus {
  if (name === 'STATUS_POSTPONED') return 'postponed';
  if (name === 'STATUS_CANCELED') return 'canceled';
  if (state === 'post') return 'final';
  if (state === 'in') return 'in_progress';
  return 'scheduled';
}

function normalize(league: League, e: RawEvent): ScoreboardGame | null {
  const c = e.competitions[0];
  const home = c.competitors.find((x) => x.homeAway === 'home');
  const away = c.competitors.find((x) => x.homeAway === 'away');
  if (!home || !away) return null;
  const rank = (t: RawCompetitor) => (t.curatedRank?.current && t.curatedRank.current <= 25 ? t.curatedRank.current : null);
  const record = (t: RawCompetitor) => t.records?.find((r) => r.type === 'total')?.summary ?? '';
  const primary = c.odds?.[0];
  const neutral = !!c.neutralSite;
  return {
    id: e.id,
    league,
    season: e.season.year,
    week: e.week?.number ?? 0,
    kickoff: e.date,
    name: neutral ? `${away.team.abbreviation} vs ${home.team.abbreviation}` : `${away.team.abbreviation} @ ${home.team.abbreviation}`,
    status: statusOf(c.status.type.name, c.status.type.state),
    statusDetail: c.status.type.detail ?? c.status.type.name,
    neutral,
    conferenceGame: !!c.conferenceCompetition,
    venue: [c.venue?.fullName, c.venue?.address?.city, c.venue?.address?.state].filter(Boolean).join(', '),
    indoor: !!c.venue?.indoor,
    weather: e.weather ? `${e.weather.displayValue ?? ''}${e.weather.temperature !== undefined ? ` ${e.weather.temperature}F` : ''}`.trim() || null : null,
    tv: c.broadcasts?.[0]?.names?.[0] ?? null,
    home: { id: home.team.id, abbr: home.team.abbreviation, name: home.team.displayName, record: record(home), rank: rank(home), score: num(home.score) },
    away: { id: away.team.id, abbr: away.team.abbreviation, name: away.team.displayName, record: record(away), rank: rank(away), score: num(away.score) },
    lines: parseLines(primary, 'close'),
    open: parseLines(primary, 'open'),
  };
}

export type Scoreboard = { league: League; season: number; week: number; games: ScoreboardGame[]; weeks: { week: number; label: string; start: string; end: string }[] };

export async function scoreboard(league: League, week?: number, season?: number): Promise<Scoreboard> {
  const params = new URLSearchParams();
  if (league === 'cfb') {
    params.set('groups', '80'); // FBS only
    params.set('limit', '300');
  }
  if (week !== undefined) {
    params.set('week', String(week));
    params.set('seasontype', '2');
    if (season) params.set('dates', String(season));
  }
  const url = `${BASE}/${PATH[league]}/scoreboard${params.size ? '?' + params.toString() : ''}`;
  const raw = await getJson<RawScoreboard>(url);
  const reg = raw.leagues?.[0]?.calendar?.find((c) => c.value === '2' || /regular/i.test(c.label));
  const weeks = (reg?.entries ?? []).map((w) => ({ week: Number(w.value), label: w.label, start: w.startDate, end: w.endDate }));
  const games = raw.events
    .filter((e) => e.season?.type === 2 || week !== undefined)
    .map((e) => normalize(league, e))
    .filter((g): g is ScoreboardGame => g !== null)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  return { league, season: raw.season.year, week: raw.week.number, games, weeks };
}

/**
 * The week you would bet on right now: ESPN's current week, or the next one once every game
 * in the current week has been played (Tuesday after an NFL week, ESPN still says week N).
 */
export async function upcomingWeek(league: League): Promise<{ season: number; week: number }> {
  const sb = await scoreboard(league);
  const allDone = sb.games.length > 0 && sb.games.every((g) => g.status === 'final' || g.status === 'canceled' || g.status === 'postponed');
  const maxWeek = sb.weeks.length ? Math.max(...sb.weeks.map((w) => w.week)) : sb.week;
  return { season: sb.season, week: allDone && sb.week < maxWeek ? sb.week + 1 : sb.week };
}

// ---- game summary ---------------------------------------------------------

export type Injury = { name: string; pos: string; status: string; detail: string };
export type RecentGame = { date: string; atVs: '@' | 'vs'; opponent: string; result: 'W' | 'L' | 'T'; score: string };
export type GameDetail = {
  injuries: { home: Injury[]; away: Injury[] };
  lastFive: { home: RecentGame[]; away: RecentGame[] };
  fpiHome: number | null; // ESPN win projection for the home team, 0-100
  books: { provider: string; details: string; total: number | null }[];
  precipitation: number | null;
};

type RawSummary = {
  header: { competitions: { competitors: { homeAway: 'home' | 'away'; team: { id: string } }[] }[] };
  injuries?: { team: { id: string }; injuries: { status?: string; athlete?: { displayName?: string; position?: { abbreviation?: string } }; details?: { type?: string; detail?: string; returnDate?: string } }[] }[];
  lastFiveGames?: { team: { id: string }; events: { gameDate: string; atVs: '@' | 'vs'; gameResult: string; score?: string; homeTeamScore?: string; awayTeamScore?: string; opponent: { abbreviation?: string } }[] }[];
  predictor?: { homeTeam?: { gameProjection?: string }; awayTeam?: { gameProjection?: string } };
  pickcenter?: { provider: { name: string }; details?: string; overUnder?: number }[];
  gameInfo?: { weather?: { precipitation?: number } };
};

const POS_PRIORITY = ['QB', 'RB', 'WR', 'TE', 'LT', 'OT', 'OL', 'G', 'C', 'EDGE', 'DE', 'DT', 'LB', 'CB', 'S', 'K', 'P'];

export async function gameDetail(league: League, eventId: string): Promise<GameDetail> {
  const raw = await getJson<RawSummary>(`${BASE}/${PATH[league]}/summary?event=${eventId}`);
  const comp = raw.header?.competitions?.[0];
  const homeId = comp?.competitors?.find((c) => c.homeAway === 'home')?.team.id;
  const pick = <T extends { team: { id: string } }>(arr: T[] | undefined, side: 'home' | 'away') =>
    arr?.find((t) => (side === 'home') === (t.team.id === homeId));

  const injuriesFor = (side: 'home' | 'away'): Injury[] => {
    const t = pick(raw.injuries, side);
    if (!t) return [];
    return t.injuries
      .filter((i) => i.status && !/active/i.test(i.status))
      .map((i) => ({
        name: i.athlete?.displayName ?? '?',
        pos: i.athlete?.position?.abbreviation ?? '',
        status: i.status ?? '',
        detail: [i.details?.type, i.details?.detail && i.details.detail !== 'Not Specified' ? i.details.detail : null].filter(Boolean).join(' - '),
      }))
      .sort((a, b) => {
        const pa = POS_PRIORITY.indexOf(a.pos);
        const pb = POS_PRIORITY.indexOf(b.pos);
        return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
      })
      .slice(0, 12);
  };
  const lastFor = (side: 'home' | 'away'): RecentGame[] => {
    const t = pick(raw.lastFiveGames, side);
    if (!t) return [];
    return t.events.slice(0, 5).map((e) => ({
      date: e.gameDate.slice(0, 10),
      atVs: e.atVs,
      opponent: e.opponent?.abbreviation ?? '?',
      result: (e.gameResult === 'W' || e.gameResult === 'L' ? e.gameResult : 'T') as 'W' | 'L' | 'T',
      score: e.score ?? `${e.homeTeamScore}-${e.awayTeamScore}`,
    }));
  };
  const fpi = num(raw.predictor?.homeTeam?.gameProjection);
  return {
    injuries: { home: injuriesFor('home'), away: injuriesFor('away') },
    lastFive: { home: lastFor('home'), away: lastFor('away') },
    fpiHome: fpi,
    books: (raw.pickcenter ?? []).map((p) => ({ provider: p.provider.name, details: p.details ?? '', total: num(p.overUnder) })),
    precipitation: raw.gameInfo?.weather?.precipitation ?? null,
  };
}

/** Run `fn` over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}
