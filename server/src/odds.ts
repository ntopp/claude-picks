/**
 * American-odds arithmetic, settlement and closing-line value. Pure functions; unit-tested.
 */
import type { Market, Side } from './engine/schema.js';

export type Lines = {
  provider: string;
  spreadHome: number | null; // home team's line, e.g. -4.5 (favorite) or +3 (dog)
  spreadHomePrice: number | null;
  spreadAwayPrice: number | null;
  total: number | null;
  overPrice: number | null;
  underPrice: number | null;
  mlHome: number | null;
  mlAway: number | null;
};

/** Profit (in units) on a winning bet of `units` at American odds `price`. */
export function profitOnWin(units: number, price: number): number {
  if (!Number.isFinite(price) || price === 0) return units; // treat garbage as even money
  return price > 0 ? (units * price) / 100 : (units * 100) / Math.abs(price);
}

/** Implied win probability (0-1) of an American price, vig included. */
export function impliedProb(price: number): number {
  return price > 0 ? 100 / (price + 100) : Math.abs(price) / (Math.abs(price) + 100);
}

/** Win rate needed to break even at this price (52.38% at -110). */
export function breakEvenRate(price = -110): number {
  return impliedProb(price);
}

export const fmtPrice = (p: number | null | undefined) => (p === null || p === undefined ? '' : p > 0 ? `+${p}` : `${p}`);
export const fmtLine = (l: number | null | undefined) => (l === null || l === undefined || l === 0 ? 'PK' : l > 0 ? `+${l}` : `${l}`);

export type Settlement = { result: 'win' | 'loss' | 'push'; margin: number };

/**
 * Settle a pick from the picked side's perspective.
 * `line` is the number the picked side got (for spreads: the picked team's own line,
 * so an away dog is +4.5 and a home favorite is -4.5; for totals: the total).
 */
export function settle(market: Market, side: Side, line: number | null, homeScore: number, awayScore: number): Settlement {
  const picked = side === 'home' ? homeScore : awayScore;
  const other = side === 'home' ? awayScore : homeScore;
  let margin: number;
  if (market === 'moneyline') margin = picked - other;
  else if (market === 'spread') margin = picked - other + (line ?? 0);
  else if (side === 'over') margin = homeScore + awayScore - (line ?? 0);
  else margin = (line ?? 0) - (homeScore + awayScore);
  return { result: margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push', margin };
}

/** Net units for a settled bet. */
export function netUnits(result: Settlement['result'], units: number, price: number): number {
  if (result === 'push') return 0;
  return result === 'win' ? profitOnWin(units, price) : -units;
}

/** The line/price the picked side is currently getting, from a Lines snapshot. */
export function pickedFrom(lines: Lines, market: Market, side: Side): { line: number | null; price: number | null } {
  if (market === 'spread') {
    if (lines.spreadHome === null) return { line: null, price: null };
    return side === 'home'
      ? { line: lines.spreadHome, price: lines.spreadHomePrice }
      : { line: lines.spreadHome === 0 ? 0 : -lines.spreadHome, price: lines.spreadAwayPrice };
  }
  if (market === 'total') return { line: lines.total, price: side === 'over' ? lines.overPrice : lines.underPrice };
  return { line: null, price: side === 'home' ? lines.mlHome : lines.mlAway };
}

/**
 * Closing line value: how much better our number was than the market's close, in points
 * (spread/total) or implied-probability points (moneyline). Positive = we beat the close.
 */
export function closingLineValue(market: Market, side: Side, line: number | null, price: number, closing: Lines): number | null {
  const c = pickedFrom(closing, market, side);
  if (market === 'spread') {
    if (line === null || c.line === null) return null;
    return line - c.line; // +4.5 vs close +3 => +1.5 ; -4.5 vs close -6 => +1.5
  }
  if (market === 'total') {
    if (line === null || c.line === null) return null;
    return side === 'over' ? c.line - line : line - c.line;
  }
  if (c.price === null) return null;
  return (impliedProb(c.price) - impliedProb(price)) * 100;
}

/** The bet-slip link for the picked side, if the book gave us one. */
export function betLinkFor(links: { spreadHome: string | null; spreadAway: string | null; over: string | null; under: string | null; mlHome: string | null; mlAway: string | null } | null, market: Market, side: Side): string | null {
  if (!links) return null;
  if (market === 'spread') return side === 'home' ? links.spreadHome : links.spreadAway;
  if (market === 'total') return side === 'over' ? links.over : links.under;
  return side === 'home' ? links.mlHome : links.mlAway;
}

/** Human label for a pick: "BUF -4.5 (-110)", "Over 53.5 (-110)", "DET ML +180". */
export function pickLabel(market: Market, side: Side, line: number | null, price: number, homeAbbr: string, awayAbbr: string): string {
  const team = side === 'home' ? homeAbbr : awayAbbr;
  if (market === 'spread') return `${team} ${fmtLine(line)} (${fmtPrice(price)})`;
  if (market === 'total') return `${side === 'over' ? 'Over' : 'Under'} ${line} (${fmtPrice(price)})`;
  return `${team} ML ${fmtPrice(price)}`;
}
