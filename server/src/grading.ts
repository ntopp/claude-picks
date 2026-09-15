/**
 * Settlement. Refreshes every week that still has an ungraded proposal, freezes closing
 * lines at kickoff, and grades finals. Every proposal is graded regardless of whether the
 * user executed it, so the engine and the human are scored separately.
 */
import type { League } from './config.js';
import { db, expireStaleProposals, getGame, logEvent, nowIso, type ProposalRow } from './db.js';
import { scoreboard } from './espn.js';
import { netUnits, settle, type Lines } from './odds.js';
import { upsertGame } from './slate.js';
import { clvFor } from './engine/run.js';
import { notify } from './notify.js';

export async function syncAndGrade(): Promise<{ refreshed: number; graded: number }> {
  expireStaleProposals();
  const weeks = db
    .prepare(`SELECT DISTINCT league, season, week FROM proposals WHERE graded_at IS NULL AND status != 'void'`)
    .all() as { league: League; season: number; week: number }[];
  let refreshed = 0;
  for (const w of weeks) {
    try {
      const sb = await scoreboard(w.league, w.week, w.season);
      for (const g of sb.games) {
        upsertGame(g);
        refreshed++;
      }
    } catch (e) {
      logEvent('warn', `Could not refresh ${w.league} week ${w.week}: ${(e as Error).message}`);
    }
  }
  return { refreshed, graded: gradePending() };
}

/** Grade every ungraded proposal whose game is final (or dead). Pure DB work; safe to call often. */
export function gradePending(): number {
  const rows = db.prepare(`SELECT * FROM proposals WHERE graded_at IS NULL AND status != 'void'`).all() as ProposalRow[];
  let graded = 0;
  const results: string[] = [];
  for (const p of rows) {
    const g = getGame(p.game_id);
    if (!g) continue;
    if (g.status === 'canceled' || g.status === 'postponed') {
      db.prepare(`UPDATE proposals SET status = 'void', graded_at = ?, decision_note = COALESCE(decision_note, ?) WHERE id = ?`).run(nowIso(), `game ${g.status}`, p.id);
      graded++;
      continue;
    }
    if (g.status !== 'final' || g.home_score === null || g.away_score === null) continue;
    if (p.status === 'pending') db.prepare(`UPDATE proposals SET status = 'expired', decided_at = ? WHERE id = ?`).run(nowIso(), p.id);
    const { result, margin } = settle(p.market, p.side, p.line, g.home_score, g.away_score);
    const units = netUnits(result, p.units, p.price);
    const closing: Lines | null = g.lines_closing_json ? (JSON.parse(g.lines_closing_json) as Lines) : null;
    const clv = closing ? clvFor(p, closing) : { clv: null, closingLine: null, closingPrice: null };
    db.prepare(
      `UPDATE proposals SET result = ?, cover_margin = ?, units_net = ?, closing_line = ?, closing_price = ?, clv = ?, graded_at = ? WHERE id = ?`,
    ).run(result, margin, units, clv.closingLine, clv.closingPrice, clv.clv, nowIso(), p.id);
    graded++;
    if (p.status === 'executed') results.push(`${result.toUpperCase()} ${p.pick} (${g.away_abbr} ${g.away_score}-${g.home_score} ${g.home_abbr})`);
  }
  if (graded) logEvent('info', `Graded ${graded} proposal(s)`);
  if (results.length) void notify(`${results.length} bet(s) settled`, results.join('\n'));
  return graded;
}
