/**
 * A "scan" = build packet -> (Claude API | Claude Code session) -> proposals in the DB.
 * Validation here is deterministic: the engine can propose anything, the insert path
 * drops what the rails do not allow and reports why.
 */
import { LEAGUE_LABEL } from '../config.js';
import { db, expireStaleProposals, getSettings, logEvent, nowIso } from '../db.js';
import { closingLineValue, pickLabel, pickedFrom, type Lines } from '../odds.js';
import { buildPacket, renderPacketMarkdown, type Packet, type PacketGame } from '../slate.js';
import { notify } from '../notify.js';
import { runClaudeSlate, runRedTeam } from './claude.js';
import { type BoardEntry, type ProposalInput, type SlateResponse } from './schema.js';

export type RunKind = 'weekly' | 'adhoc';

export function weekLabel(packet: Packet) {
  return packet.leagues.map((l) => `${LEAGUE_LABEL[l.league]} wk ${l.week}`).join(' / ');
}

export function createRun(kind: RunKind, engine: 'api' | 'session', packet: Packet): number {
  const r = db
    .prepare('INSERT INTO runs (started_at, kind, engine, leagues, week_label, packet_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nowIso(), kind, engine, packet.leagues.map((l) => l.league).join(','), weekLabel(packet), JSON.stringify(packet));
  return Number(r.lastInsertRowid);
}

function finishRun(id: number, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  db.prepare(`UPDATE runs SET finished_at = ?${keys.map((k) => `, ${k} = ?`).join('')} WHERE id = ?`).run(nowIso(), ...keys.map((k) => patch[k] as never), id);
}

export type InsertResult = { inserted: number[]; dropped: { game_id: string; pick: string; reason: string }[] };

export function insertProposals(runId: number | null, packet: Packet, inputs: ProposalInput[]): InsertResult {
  const s = getSettings();
  const games = new Map<string, PacketGame>();
  for (const l of packet.leagues) for (const g of l.games) games.set(g.id, g);

  const inserted: number[] = [];
  const dropped: InsertResult['dropped'] = [];
  const seenGames = new Set<string>();

  // Enforce the weekly cap across everything still live for these games' weeks: lowest confidence loses.
  const weekKeys = new Set(packet.leagues.map((l) => `${l.league}:${l.season}:${l.week}`));
  const alreadyThisWeek = (db.prepare(`SELECT league, season, week, game_id FROM proposals WHERE status IN ('pending','executed')`).all() as { league: string; season: number; week: number; game_id: string }[]).filter((r) =>
    weekKeys.has(`${r.league}:${r.season}:${r.week}`),
  );
  for (const r of alreadyThisWeek) seenGames.add(r.game_id);
  let budget = Math.max(0, s.maxPicksPerWeek - alreadyThisWeek.length);

  const stmt = db.prepare(`INSERT INTO proposals
    (run_id, created_at, expires_at, game_id, league, season, week, kickoff, matchup, market, side, pick, line, price, units, confidence, edge_type, thesis, bear_case, key_factors_json, lines_at_proposal_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`);

  const ordered = [...inputs].sort((a, b) => b.confidence - a.confidence);
  for (const p of ordered) {
    const g = games.get(p.game_id);
    const label = g ? pickLabel(p.market, p.side, p.line, p.price, g.home.abbr, g.away.abbr) : `${p.market} ${p.side} ${p.line ?? ''} ${p.price}`;
    const drop = (reason: string) => dropped.push({ game_id: p.game_id, pick: label, reason });
    if (!g) {
      drop('game_id is not in the packet');
      continue;
    }
    if (g.status !== 'scheduled') {
      drop(`game is ${g.status}`);
      continue;
    }
    if (new Date(g.kickoff).getTime() < Date.now()) {
      drop('already kicked off');
      continue;
    }
    if ((p.market === 'total') !== (p.side === 'over' || p.side === 'under')) {
      drop('side does not match market (totals are over/under, spreads and moneylines are home/away)');
      continue;
    }
    if (p.market !== 'moneyline' && p.line === null) {
      drop('spread/total needs a line');
      continue;
    }
    if (p.confidence < s.minConfidence) {
      drop(`confidence ${p.confidence} < ${s.minConfidence}`);
      continue;
    }
    if (p.market === 'moneyline' && p.price < 0 && p.price < s.maxFavoritePrice) {
      drop(`moneyline favorite ${p.price} is shorter than ${s.maxFavoritePrice}`);
      continue;
    }
    if (seenGames.has(g.id)) {
      drop('one pick per game');
      continue;
    }
    // Stale-line check: the number must still be close to what the book shows now.
    const lines = g.lines;
    if (lines) {
      const cur = pickedFrom(lines, p.market, p.side);
      if (p.market !== 'moneyline' && cur.line !== null && p.line !== null && Math.abs(cur.line - p.line) > s.lineTolerance) {
        drop(`line ${p.line} is more than ${s.lineTolerance} from the current ${cur.line}`);
        continue;
      }
    }
    if (budget <= 0) {
      drop(`weekly cap of ${s.maxPicksPerWeek} picks reached`);
      continue;
    }
    const units = Math.min(p.units, s.maxUnitsPerBet);
    const r = stmt.run(
      runId, nowIso(), g.kickoff, g.id, g.league, g.season, g.week, g.kickoff, g.name,
      p.market, p.side, label, p.line, p.price, units, p.confidence, p.edge_type, p.thesis, p.bear_case,
      JSON.stringify(p.key_factors), lines ? JSON.stringify(lines) : null,
    );
    inserted.push(Number(r.lastInsertRowid));
    seenGames.add(g.id);
    budget--;
  }
  return { inserted, dropped };
}

/** Store the engine's read on each game it evaluated; unknown game ids are ignored. */
export function upsertViews(runId: number | null, packet: Packet, board: BoardEntry[]): number {
  const ids = new Set(packet.leagues.flatMap((l) => l.games.map((g) => g.id)));
  const stmt = db.prepare(
    `INSERT INTO game_views (game_id, run_id, updated_at, lean, confidence, note) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(game_id) DO UPDATE SET run_id = excluded.run_id, updated_at = excluded.updated_at, lean = excluded.lean, confidence = excluded.confidence, note = excluded.note`,
  );
  let n = 0;
  for (const b of board) {
    if (!ids.has(b.game_id)) continue;
    stmt.run(b.game_id, runId, nowIso(), b.lean.trim() || 'no lean', b.confidence, b.note.trim());
    n++;
  }
  return n;
}

/** One line per pick for the push notification body. */
function pickList(ids: number[]): string {
  return ids
    .map((id) => db.prepare('SELECT matchup, pick, units, confidence FROM proposals WHERE id = ?').get(id) as { matchup: string; pick: string; units: number; confidence: number })
    .map((p) => `${p.matchup}: ${p.pick} · ${p.units}u · conf ${p.confidence}`)
    .join('\n');
}

/** Import a response produced by a Claude Code session. */
export function recordSessionSlate(kind: RunKind, packet: Packet, response: SlateResponse) {
  expireStaleProposals();
  const runId = createRun(kind, 'session', packet);
  const result = insertProposals(runId, packet, response.proposals);
  const views = upsertViews(runId, packet, response.board);
  finishRun(runId, { summary: response.week_summary, response_json: JSON.stringify({ ...response, dropped: result.dropped }) });
  logEvent('info', `Session slate: ${result.inserted.length} proposal(s) inserted, ${result.dropped.length} dropped, ${views} game view(s)`, result);
  if (result.inserted.length) void notify(`${result.inserted.length} new pick(s) to review`, pickList(result.inserted), { priority: 'high', tags: 'football,bell' });
  return { runId, ...result };
}

/** Full API run: packet -> Claude (with web search) -> red team -> insert. */
export async function runApiScan(kind: RunKind, opts: { userNote?: string; leagues?: ('nfl' | 'cfb')[]; week?: Partial<Record<'nfl' | 'cfb', number>> } = {}) {
  expireStaleProposals();
  const s = getSettings();
  const packet = await buildPacket({ leagues: opts.leagues, week: opts.week });
  const runId = createRun(kind, 'api', packet);
  try {
    const md = renderPacketMarkdown(packet);
    const scan = await runClaudeSlate(md, { webSearch: s.webSearch, userNote: opts.userNote });
    let proposals = scan.parsed.proposals;
    const games = new Map<string, PacketGame>();
    for (const l of packet.leagues) for (const g of l.games) games.set(g.id, g);
    const labelled = proposals.map((p) => {
      const g = games.get(p.game_id);
      return { ...p, label: g ? pickLabel(p.market, p.side, p.line, p.price, g.home.abbr, g.away.abbr) : p.game_id };
    });
    const red = await runRedTeam(md, labelled);
    let redSummary: string | null = null;
    if (red) {
      redSummary = red.parsed.overall;
      const byGame = new Map(red.parsed.reviews.map((r) => [r.game_id, r]));
      proposals = proposals
        .filter((p) => byGame.get(p.game_id)?.verdict !== 'drop')
        .map((p) => {
          const r = byGame.get(p.game_id);
          return r ? { ...p, confidence: Math.max(1, Math.min(10, p.confidence + r.confidence_adjustment)) } : p;
        });
      scan.usage.input += red.usage.input;
      scan.usage.output += red.usage.output;
    }
    const result = insertProposals(runId, packet, proposals);
    upsertViews(runId, packet, scan.parsed.board);
    finishRun(runId, {
      summary: scan.parsed.week_summary,
      response_json: JSON.stringify({ ...scan.parsed, model: scan.model, red_team: red?.parsed ?? null, red_summary: redSummary, dropped: result.dropped, searches: scan.usage.searches }),
      input_tokens: scan.usage.input,
      output_tokens: scan.usage.output,
    });
    logEvent('info', `API slate: ${result.inserted.length} proposal(s) inserted, ${result.dropped.length} dropped, ${scan.usage.searches} searches`, result);
    if (result.inserted.length) void notify(`${result.inserted.length} new pick(s) to review`, pickList(result.inserted), { priority: 'high', tags: 'football,bell' });
    return { runId, ...result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    finishRun(runId, { error: message });
    logEvent('error', `API scan failed: ${message}`);
    throw e;
  }
}

/** Re-derive CLV for a proposal against a closing snapshot (used by grading). */
export function clvFor(p: { market: 'spread' | 'total' | 'moneyline'; side: 'home' | 'away' | 'over' | 'under'; line: number | null; price: number }, closing: Lines) {
  const c = pickedFrom(closing, p.market, p.side);
  return { clv: closingLineValue(p.market, p.side, p.line, p.price, closing), closingLine: c.line, closingPrice: c.price };
}
