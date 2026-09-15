import { z } from 'zod';

export const MarketSchema = z.enum(['spread', 'total', 'moneyline']);
export const SideSchema = z.enum(['home', 'away', 'over', 'under']);
export type Market = z.infer<typeof MarketSchema>;
export type Side = z.infer<typeof SideSchema>;

export const EdgeTypeSchema = z.enum(['injury', 'weather', 'situational', 'line_value', 'matchup', 'coaching', 'motivation', 'other']);

/** One pick. Shared by the API engine and the session import path. */
export const ProposalSchema = z.object({
  /** ESPN event id exactly as printed in the packet. */
  game_id: z.string().min(1),
  market: MarketSchema,
  /** home/away for spread and moneyline, over/under for totals. */
  side: SideSchema,
  /** The picked side's number: the picked team's own spread (+4.5 for a dog, -4.5 for a favorite) or the total. null for moneyline. */
  line: z.number().nullable(),
  /** American price you are accepting (-110 etc.). Use the packet's price for that side. */
  price: z.number().int(),
  /** Stake in units. 1 is normal; only the strongest ideas get more (settings cap it). */
  units: z.number().min(0.5).max(5),
  confidence: z.number().int().min(1).max(10),
  /** What kind of edge this is; the scoreboard groups results by it. */
  edge_type: EdgeTypeSchema,
  thesis: z.string().min(20),
  /** The strongest honest case AGAINST this bet. If it beats the thesis, do not propose. */
  bear_case: z.string().min(20),
  /** Short bullet facts the thesis rests on (injury, weather, rest, scheme...). */
  key_factors: z.array(z.string()).max(8),
});
export type ProposalInput = z.infer<typeof ProposalSchema>;

export const SlateResponseSchema = z.object({
  /** 2-5 sentences: the shape of the week, where the market looks soft, what you deliberately avoided. */
  week_summary: z.string(),
  proposals: z.array(ProposalSchema),
  /** Games you looked hard at and passed on, with the reason. Keeps the engine honest about selectivity. */
  passes: z.array(z.object({ game_id: z.string(), note: z.string() })).max(20),
  /** One thing the user should learn from this slate about football betting. */
  teaching_note: z.string(),
});
export type SlateResponse = z.infer<typeof SlateResponseSchema>;
