/**
 * The weekly packet: everything the engine gets to reason from. Pulls the slate for each
 * league, enriches every game from the summary endpoint, records the games (and their
 * lines) in the DB, and renders markdown for a Claude Code session or the API engine.
 */
import { LEAGUE_LABEL, LEAGUES, type League } from './config.js';
import { db, getSettings, listProposals, nowIso, type GameRow } from './db.js';
import { gameDetail, mapLimit, scoreboard, upcomingWeek, type GameDetail, type ScoreboardGame } from './espn.js';
import { fmtLine, fmtPrice, type Lines } from './odds.js';

export type PacketGame = ScoreboardGame & { detail: GameDetail | null };

export type Packet = {
  generatedAt: string;
  leagues: {
    league: League;
    season: number;
    week: number;
    games: PacketGame[];
  }[];
  /** Everything already proposed for the games in this packet, so the engine does not repeat itself. */
  existing: { game: string; pick: string; status: string; confidence: number }[];
  settings: { defaultUnits: number; maxUnitsPerBet: number; maxPicksPerWeek: number; minConfidence: number; maxFavoritePrice: number };
};

export type BuildOptions = {
  leagues?: League[];
  week?: Partial<Record<League, number>>;
  /** Enrich every game (injuries, last five, FPI). Default: NFL all games, CFB ranked or close games only. */
  detailAll?: boolean;
  /** Skip the per-game summary calls entirely (fast, lines-only packet). */
  noDetail?: boolean;
  focus?: string[];
};

export function upsertGame(g: ScoreboardGame) {
  const existing = db.prepare('SELECT status, lines_json, lines_open_json, lines_closing_json FROM games WHERE id = ?').get(g.id) as
    | Pick<GameRow, 'status' | 'lines_json' | 'lines_open_json' | 'lines_closing_json'>
    | undefined;
  const started = g.status !== 'scheduled';
  // Freeze the closing line the first time we see the game past kickoff: the last lines we saw while it was scheduled.
  let closing = existing?.lines_closing_json ?? null;
  if (started && !closing) closing = existing?.lines_json ?? (g.lines ? JSON.stringify(g.lines) : null);
  const linesJson = !started && g.lines ? JSON.stringify(g.lines) : (existing?.lines_json ?? (g.lines ? JSON.stringify(g.lines) : null));
  const openJson = existing?.lines_open_json ?? (g.open ? JSON.stringify(g.open) : null);
  db.prepare(
    `INSERT INTO games (id, league, season, week, kickoff, name, home_id, home_abbr, home_name, home_rank, away_id, away_abbr, away_name, away_rank, neutral, status,
       home_score, away_score, lines_open_json, lines_json, lines_closing_json, lines_updated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kickoff = excluded.kickoff, name = excluded.name, home_rank = excluded.home_rank, away_rank = excluded.away_rank, status = excluded.status,
       home_score = excluded.home_score, away_score = excluded.away_score, lines_open_json = excluded.lines_open_json, lines_json = excluded.lines_json,
       lines_closing_json = excluded.lines_closing_json, lines_updated_at = excluded.lines_updated_at, updated_at = excluded.updated_at`,
  ).run(
    g.id, g.league, g.season, g.week, g.kickoff, g.name,
    g.home.id, g.home.abbr, g.home.name, g.home.rank, g.away.id, g.away.abbr, g.away.name, g.away.rank,
    g.neutral ? 1 : 0, g.status, g.home.score, g.away.score, openJson, linesJson, closing, g.lines ? nowIso() : null, nowIso(),
  );
}

function wantsDetail(g: ScoreboardGame, opts: BuildOptions): boolean {
  if (opts.noDetail) return false;
  if (opts.detailAll || g.league === 'nfl') return true;
  if (opts.focus?.includes(g.id)) return true;
  if (g.home.rank || g.away.rank) return true;
  const spread = g.lines?.spreadHome;
  return spread !== null && spread !== undefined && Math.abs(spread) <= 14;
}

export async function buildPacket(opts: BuildOptions = {}): Promise<Packet> {
  const leagues = opts.leagues ?? LEAGUES;
  const s = getSettings();
  const out: Packet['leagues'] = [];
  for (const league of leagues) {
    const target = opts.week?.[league] !== undefined ? { week: opts.week[league] as number, season: undefined as number | undefined } : await upcomingWeek(league);
    const sb = await scoreboard(league, target.week, target.season);
    const games = sb.games.filter((g) => g.week === target.week || opts.week?.[league] !== undefined);
    for (const g of games) upsertGame(g);
    const enriched = await mapLimit(games, 6, async (g): Promise<PacketGame> => {
      if (!wantsDetail(g, opts) || g.status !== 'scheduled') return { ...g, detail: null };
      try {
        return { ...g, detail: await gameDetail(league, g.id) };
      } catch (e) {
        console.error(`detail failed for ${g.name}: ${(e as Error).message}`);
        return { ...g, detail: null };
      }
    });
    out.push({ league, season: sb.season, week: target.week, games: enriched });
  }
  const ids = new Set(out.flatMap((l) => l.games.map((g) => g.id)));
  const existing = listProposals({ limit: 1000 })
    .filter((p) => ids.has(p.game_id))
    .map((p) => ({ game: p.matchup, pick: p.pick, status: p.status, confidence: p.confidence }));
  return {
    generatedAt: nowIso(),
    leagues: out,
    existing,
    settings: { defaultUnits: s.defaultUnits, maxUnitsPerBet: s.maxUnitsPerBet, maxPicksPerWeek: s.maxPicksPerWeek, minConfidence: s.minConfidence, maxFavoritePrice: s.maxFavoritePrice },
  };
}

// ---- markdown -------------------------------------------------------------

const kickoffLocal = (iso: string, tz: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function linesStr(g: ScoreboardGame): string {
  const l = g.lines;
  if (!l) return 'no line';
  const fav = l.spreadHome === null ? '' : l.spreadHome <= 0 ? `${g.home.abbr} ${fmtLine(l.spreadHome)}` : `${g.away.abbr} ${fmtLine(-l.spreadHome)}`;
  const parts = [
    fav ? `${fav} (${fmtPrice(l.spreadHomePrice)}/${fmtPrice(l.spreadAwayPrice)})` : null,
    l.total !== null ? `O/U ${l.total} (${fmtPrice(l.overPrice)}/${fmtPrice(l.underPrice)})` : null,
    l.mlHome !== null ? `ML ${g.home.abbr} ${fmtPrice(l.mlHome)} / ${g.away.abbr} ${fmtPrice(l.mlAway)}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function movementStr(g: ScoreboardGame): string {
  const o = g.open;
  const l = g.lines;
  if (!o || !l) return '';
  const parts: string[] = [];
  if (o.spreadHome !== null && l.spreadHome !== null && o.spreadHome !== l.spreadHome) parts.push(`spread ${g.home.abbr} ${fmtLine(o.spreadHome)} → ${fmtLine(l.spreadHome)}`);
  if (o.total !== null && l.total !== null && o.total !== l.total) parts.push(`total ${o.total} → ${l.total}`);
  if (o.mlHome !== null && l.mlHome !== null && o.mlHome !== l.mlHome) parts.push(`ML ${g.home.abbr} ${fmtPrice(o.mlHome)} → ${fmtPrice(l.mlHome)}`);
  return parts.join('; ');
}

const teamLabel = (t: ScoreboardGame['home']) => `${t.rank ? `#${t.rank} ` : ''}${t.name} (${t.abbr}${t.record ? ` ${t.record}` : ''})`;

export function renderPacketMarkdown(p: Packet, tz = 'America/Chicago'): string {
  const md: string[] = [];
  md.push(`# Football slate packet — generated ${new Date(p.generatedAt).toLocaleString('en-US', { timeZone: tz })}`);
  md.push('');
  md.push(
    `Rails: default stake ${p.settings.defaultUnits}u, max ${p.settings.maxUnitsPerBet}u per bet, max ${p.settings.maxPicksPerWeek} picks this week across both leagues, ` +
      `confidence < ${p.settings.minConfidence} is dropped, moneyline favorites shorter than ${p.settings.maxFavoritePrice} are dropped. ` +
      `Prices are DraftKings via ESPN. Spread lines are shown from the FAVORITE's side; when you propose, give the PICKED team's own line.`,
  );
  if (p.existing.length) {
    md.push('');
    md.push('## Already proposed for these games (do not duplicate)');
    for (const e of p.existing) md.push(`- ${e.game}: ${e.pick} — ${e.status}, conf ${e.confidence}`);
  }
  for (const L of p.leagues) {
    md.push('');
    md.push(`## ${LEAGUE_LABEL[L.league]} — week ${L.week} (${L.games.length} games)`);
    md.push('');
    md.push('| id | kickoff | matchup | line | movement (open → now) | weather | FPI home |');
    md.push('|---|---|---|---|---|---|---|');
    for (const g of L.games) {
      const fpi = g.detail?.fpiHome !== null && g.detail?.fpiHome !== undefined ? `${g.detail.fpiHome}%` : '';
      md.push(
        `| ${g.id} | ${kickoffLocal(g.kickoff, tz)} | ${g.away.rank ? `#${g.away.rank} ` : ''}${g.away.abbr}${g.away.record ? ` (${g.away.record})` : ''} ${g.neutral ? 'vs' : '@'} ${g.home.rank ? `#${g.home.rank} ` : ''}${g.home.abbr}${g.home.record ? ` (${g.home.record})` : ''} | ${linesStr(g)} | ${movementStr(g)} | ${g.indoor ? 'dome' : (g.weather ?? '')} | ${fpi} |`,
      );
    }
    const detailed = L.games.filter((g) => g.detail);
    if (detailed.length) {
      md.push('');
      md.push(`### ${LEAGUE_LABEL[L.league]} game detail`);
      for (const g of detailed) {
        const d = g.detail!;
        md.push('');
        md.push(`#### ${g.id} — ${teamLabel(g.away)} ${g.neutral ? 'vs' : '@'} ${teamLabel(g.home)}`);
        md.push(`${kickoffLocal(g.kickoff, tz)} · ${g.venue}${g.indoor ? ' (dome)' : ''}${g.tv ? ` · ${g.tv}` : ''}${g.conferenceGame ? ' · conference game' : ''}${g.neutral ? ' · neutral site' : ''}`);
        md.push(`Lines: ${linesStr(g)}${movementStr(g) ? ` — moved: ${movementStr(g)}` : ''}`);
        if (d.books.length > 1) md.push(`Books: ${d.books.map((b) => `${b.provider} ${b.details}${b.total ? ` o/u ${b.total}` : ''}`).join(' | ')}`);
        if (!g.indoor && (g.weather || d.precipitation !== null)) md.push(`Weather: ${g.weather ?? ''}${d.precipitation !== null ? ` · precip ${d.precipitation}%` : ''}`);
        if (d.fpiHome !== null) md.push(`ESPN FPI: ${g.home.abbr} ${d.fpiHome}% / ${g.away.abbr} ${Math.round((100 - d.fpiHome) * 10) / 10}%`);
        for (const side of ['away', 'home'] as const) {
          const t = g[side];
          const inj = d.injuries[side];
          const last = d.lastFive[side];
          md.push(`- **${t.abbr}** last 5: ${last.length ? last.map((r) => `${r.result} ${r.atVs}${r.opponent} ${r.score} (${r.date.slice(5)})`).join(', ') : 'n/a'}`);
          md.push(`  injuries: ${inj.length ? inj.map((i) => `${i.name} (${i.pos}, ${i.status}${i.detail ? `, ${i.detail}` : ''})`).join('; ') : 'none listed'}`);
        }
      }
    }
  }
  md.push('');
  md.push('## What to return');
  md.push('A JSON object matching SlateResponseSchema (server/src/engine/schema.ts): week_summary, proposals[], passes[], teaching_note. Every proposal needs game_id from the tables above, market, side, the picked side\'s line, price, units, confidence, edge_type, thesis, bear_case, key_factors.');
  return md.join('\n');
}

/** Lines the picked side is getting right now, for validation at insert time. */
export function currentLinesFor(gameId: string): Lines | null {
  const row = db.prepare('SELECT lines_json FROM games WHERE id = ?').get(gameId) as { lines_json: string | null } | undefined;
  return row?.lines_json ? (JSON.parse(row.lines_json) as Lines) : null;
}
