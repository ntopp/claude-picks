import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config, hasAnthropicKey } from '../config.js';
import { PLAYBOOK, RED_TEAM } from './prompt.js';
import { SlateResponseSchema, type ProposalInput, type SlateResponse } from './schema.js';

export const RedTeamSchema = z.object({
  reviews: z.array(
    z.object({
      game_id: z.string(),
      verdict: z.enum(['keep', 'drop']),
      confidence_adjustment: z.number().int().min(-3).max(1),
      reason: z.string(),
    }),
  ),
  overall: z.string(),
});
export type RedTeam = z.infer<typeof RedTeamSchema>;

let client: Anthropic | null = null;
function getClient() {
  if (!hasAnthropicKey()) throw new Error('ANTHROPIC_API_KEY is not set; use the Claude Code session engine instead (npm run packet / npm run propose).');
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

type Usage = { input: number; output: number; cacheRead: number; searches: number };

/**
 * One structured-output call with optional web search. Server tools can pause a long turn
 * (`pause_turn`); we push the partial assistant turn back and continue until a real stop.
 */
async function structuredCall<T>(system: string, user: string, schema: z.ZodType<T>, opts: { webSearch: boolean; maxTokens: number }) {
  const c = getClient();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: user }];
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, searches: 0 };
  let model = config.anthropic.model;
  for (let turn = 0; turn < 8; turn++) {
    const stream = c.beta.messages.stream({
      model: config.anthropic.model,
      max_tokens: opts.maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      tools: opts.webSearch ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 25 }] : undefined,
      output_config: { format: zodOutputFormat(schema as z.ZodType) },
    });
    const msg = await stream.finalMessage();
    usage.input += msg.usage.input_tokens;
    usage.output += msg.usage.output_tokens;
    usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    usage.searches += msg.usage.server_tool_use?.web_search_requests ?? 0;
    model = msg.model;
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    if (msg.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: msg.content });
      continue;
    }
    const text = msg.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { parsed: schema.parse(JSON.parse(text)), usage, model };
  }
  throw new Error('Engine call kept pausing; giving up after 8 turns.');
}

export async function runClaudeSlate(packetMarkdown: string, opts: { webSearch: boolean; userNote?: string }) {
  const instructions = opts.webSearch
    ? 'Before proposing, research the games you are drawn to: this week\'s injury reports and practice participation, weather at kickoff for outdoor games, coaching or QB changes, and any beat-writer news the packet would not have. Cite what you found in key_factors.'
    : 'You have no research tools on this run; reason from the packet only and say so in key_factors where you would normally verify.';
  const user = [instructions, opts.userNote ? `Operator note: ${opts.userNote}` : '', '', packetMarkdown].filter(Boolean).join('\n');
  return structuredCall<SlateResponse>(PLAYBOOK, user, SlateResponseSchema, { webSearch: opts.webSearch, maxTokens: 32000 });
}

/** Adversarial review of a slate's proposals. Returns null when there is nothing to review. */
export async function runRedTeam(packetMarkdown: string, proposals: (ProposalInput & { label: string })[]) {
  if (proposals.length === 0) return null;
  const list = proposals
    .map(
      (p) =>
        `- ${p.game_id}: ${p.label} (${p.market}, ${p.units}u, conf ${p.confidence}/10, edge ${p.edge_type})\n  thesis: ${p.thesis}\n  analyst bear case: ${p.bear_case}\n  factors: ${p.key_factors.join(' | ')}`,
    )
    .join('\n');
  return structuredCall<RedTeam>(RED_TEAM, `## Proposals under review\n${list}\n\n${packetMarkdown}`, RedTeamSchema, { webSearch: false, maxTokens: 16000 });
}
