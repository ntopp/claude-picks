/**
 * A board lean is free text in market terms ("BUF -4.5", "Under 53.5", "DET ML", "no lean").
 * This turns it into a gradeable bet at the line and price that stood when it was written.
 */
import type { Market, Side } from './engine/schema.js';
import { pickedFrom, type Lines } from './odds.js';

type Teams = { home_abbr: string; away_abbr: string };

export function parseLean(lean: string, g: Teams): { market: Market; side: Side } | null {
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

export function teamSide(abbr: string, g: Teams): 'home' | 'away' | null {
  const a = abbr.toUpperCase();
  if (a === g.home_abbr.toUpperCase()) return 'home';
  if (a === g.away_abbr.toUpperCase()) return 'away';
  return null;
}

/** The lean as a bet at the given lines: null when it is "no lean", unparseable, or the market has no number. */
export function resolveLean(lean: string, g: Teams, lines: Lines | null): { market: Market; side: Side; line: number | null; price: number } | null {
  const parsed = parseLean(lean, g);
  if (!parsed || !lines) return null;
  const cur = pickedFrom(lines, parsed.market, parsed.side);
  if (parsed.market !== 'moneyline' && cur.line === null) return null;
  if (parsed.market === 'moneyline' && cur.price === null) return null;
  return { market: parsed.market, side: parsed.side, line: cur.line, price: cur.price ?? -110 };
}
