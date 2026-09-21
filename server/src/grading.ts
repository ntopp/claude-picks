/**
 * Settlement. Refreshes every week that still has an unfinished game (this week's and next week's
 * slates), freezes closing lines at kickoff, and grades finals: every proposal, executed or not, and
 * every board lean, so the engine's picks, the human's choices and the engine's reads are all scored.
 */
import type { League } from './config.js';
import { db, expireStaleProposals, getGame, logEvent, nowIso, type ProposalRow } from './db.js';
import { scoreboard } from './espn.js';
import { impliedProb, netUnits, pickedFrom, settle, type Lines } from './odds.js';
import type { Market, Side } from './engine/schema.js';
import { upsertGame } from './slate.js';
import { clvFor } from './engine/run.js';
import { notify } from './notify.js';

export async function syncAndGrade(): Promise<{ refreshed: number; graded: number; leansGraded: number }> {
  expireStaleProposals();
  // Any week with a game not yet final: keeps line history flowing for next week and lets every board
  // lean be graded, not just the games we bet.
  const weeks = db
    .prepare(`SELECT DISTINCT league, season, week FROM games WHERE status IN ('scheduled', 'in_progress') AND kickoff < ?`)
    .all(new Date(Date.now() + 8 * 86400_000).toISOString()) as { league: League; season: number; week: number }[];
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
  const graded = gradePending();
  const leansGraded = gradeLeans();
  return { refreshed, graded, leansGraded };
}

/**
 * True while any ungraded pick's game is plausibly being played: ESPN says in_progress, or it
 * kicked off within the last four hours and we have not yet seen a final.
 */
export function gameInProgress(): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM proposals p JOIN games g ON g.id = p.game_id
       WHERE p.graded_at IS NULL AND p.status != 'void'
         AND (g.status = 'in_progress' OR (g.status = 'scheduled' AND p.kickoff <= ? AND p.kickoff >= ?))`,
    )
    .get(nowIso(), new Date(Date.now() - 4 * 3600_000).toISOString()) as { n: number };
  return row.n > 0;
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
    // Price CLV: how many implied-probability points better our price was than the close on the same side
    // (a -105 that closes -115 is worth ~2 points even when the line never moved).
    const clvPrice = clv.closingPrice !== null ? (impliedProb(clv.closingPrice) - impliedProb(p.price)) * 100 : null;
    db.prepare(
      `UPDATE proposals SET result = ?, cover_margin = ?, units_net = ?, closing_line = ?, closing_price = ?, clv = ?, clv_price = ?, graded_at = ? WHERE id = ?`,
    ).run(result, margin, units, clv.closingLine, clv.closingPrice, clv.clv, clvPrice, nowIso(), p.id);
    graded++;
    if (p.status === 'executed') results.push(`${result.toUpperCase()} ${p.pick} (${g.away_abbr} ${g.away_score}-${g.home_score} ${g.home_abbr})`);
  }
  if (graded) logEvent('info', `Graded ${graded} proposal(s)`);
  if (results.length) void notify(`${results.length} bet(s) settled`, results.join('\n'), { tags: 'football,chart_with_upwards_trend' });
  return graded;
}

/** Grade board leans (latest view and history) whose game is final. A lean with no market ("no lean") is skipped. */
export function gradeLeans(): number {
  let n = 0;
  for (const table of ['game_views', 'game_view_history'] as const) {
    const rows = db
      .prepare(
        `SELECT v.rowid AS rid, v.market, v.side, v.line, g.home_score, g.away_score
         FROM ${table} v JOIN games g ON g.id = v.game_id
         WHERE v.graded_at IS NULL AND v.market IS NOT NULL AND g.status = 'final' AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL`,
      )
      .all() as { rid: number; market: Market; side: Side; line: number | null; home_score: number; away_score: number }[];
    const upd = db.prepare(`UPDATE ${table} SET result = ?, margin = ?, graded_at = ? WHERE rowid = ?`);
    for (const v of rows) {
      const { result, margin } = settle(v.market, v.side, v.line, v.home_score, v.away_score);
      upd.run(result, margin, nowIso(), v.rid);
      n++;
    }
  }
  if (n) logEvent('info', `Graded ${n} board lean(s)`);
  return n;
}

/**
 * Backfill for views recorded before leans were parsed: resolve each against the earliest line snapshot
 * at or before the view (else the current line) and seed history. Idempotent.
 */
export function backfillLeanBets(resolve: (lean: string, g: { home_abbr: string; away_abbr: string }, lines: Lines | null) => { market: Market; side: Side; line: number | null; price: number } | null): number {
  const rows = db
    .prepare(
      `SELECT v.game_id, v.run_id, v.updated_at, v.lean, v.confidence, v.note, g.home_abbr, g.away_abbr, g.lines_json,
              (SELECT lines_json FROM line_snapshots s WHERE s.game_id = v.game_id AND s.ts <= v.updated_at ORDER BY s.ts DESC LIMIT 1) AS snap_before,
              (SELECT lines_json FROM line_snapshots s WHERE s.game_id = v.game_id ORDER BY s.ts ASC LIMIT 1) AS snap_first
       FROM game_views v JOIN games g ON g.id = v.game_id
       WHERE v.market IS NULL AND v.lean != 'no lean'`,
    )
    .all() as { game_id: string; run_id: number | null; updated_at: string; lean: string; confidence: number; note: string; home_abbr: string; away_abbr: string; lines_json: string | null; snap_before: string | null; snap_first: string | null }[];
  let n = 0;
  for (const r of rows) {
    const src = r.snap_before ?? r.snap_first ?? r.lines_json;
    const bet = resolve(r.lean, r, src ? (JSON.parse(src) as Lines) : null);
    if (!bet) continue;
    db.prepare('UPDATE game_views SET market = ?, side = ?, line = ?, price = ? WHERE game_id = ?').run(bet.market, bet.side, bet.line, bet.price, r.game_id);
    const has = db.prepare('SELECT 1 FROM game_view_history WHERE game_id = ? AND ts = ?').get(r.game_id, r.updated_at);
    if (!has) {
      db.prepare('INSERT INTO game_view_history (game_id, run_id, ts, lean, confidence, note, market, side, line, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        r.game_id, r.run_id, r.updated_at, r.lean, r.confidence, r.note, bet.market, bet.side, bet.line, bet.price,
      );
    }
    n++;
  }
  return n;
}

// Re-export so callers grading a lean by hand can reuse the same current-line lookup.
export { pickedFrom };
