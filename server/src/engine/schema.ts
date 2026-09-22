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

/**
 * A read on one game that is NOT a bet: which way you lean, how strongly, and why in a line.
 * Every game on the slate should get one so the board is complete; confidence under 5 means "no bet".
 */
export const BoardEntrySchema = z.object({
  game_id: z.string().min(1),
  /** The side you would take if forced, in market terms: "BUF -4.5", "Under 53.5", "DET ML", or "no lean". */
  lean: z.string().max(40),
  confidence: z.number().int().min(1).max(10),
  note: z.string().max(300),
});
export type BoardEntry = z.infer<typeof BoardEntrySchema>;

/** What the weekly review writes back: the narrative plus what it learned. */
export const ReviewResponseSchema = z.object({
  narrative: z.string().min(50),
  observations: z.array(z.object({ text: z.string().min(5), evidence: z.string().default('') })).max(10),
  /** Playbook changes. Only past the evidence guardrails; an empty list is the normal answer. */
  proposals: z.array(z.object({ text: z.string().min(5), evidence: z.string().min(5) })).max(3),
  next_week_focus: z.string().default(''),
});
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

export const SlateResponseSchema = z.object({
  /** 2-5 sentences: the shape of the week, where the market looks soft, what you deliberately avoided. */
  week_summary: z.string(),
  proposals: z.array(ProposalSchema),
  /** Games you looked hard at and passed on, with the reason. Keeps the engine honest about selectivity. */
  passes: z.array(z.object({ game_id: z.string(), note: z.string() })).max(20),
  /** One entry per game on the slate (both leagues): lean, confidence, note. Omit games you did not evaluate. */
  board: z.array(BoardEntrySchema).max(150).default([]),
  /** One thing the user should learn from this slate about football betting. */
  teaching_note: z.string(),
});
export type SlateResponse = z.infer<typeof SlateResponseSchema>;
