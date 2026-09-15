import Anthropic from '@anthropic-ai/sdk';
import { config, hasAnthropicKey } from '../config.js';

/** Short free-text commentary on a review report. API engine only. */
export async function runNarrative(reportMarkdown: string): Promise<string> {
  if (!hasAnthropicKey()) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const stream = client.beta.messages.stream({
    model: config.anthropic.model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system:
      'You review the results of a paper football-betting experiment run by an AI engine and a human who chooses which picks to execute. Write 150-300 words, plain prose, no headers: what the numbers say so far (respecting small samples), which edge types and confidence levels are earning their keep, whether the human filter helps, and one concrete adjustment for next week. Be honest about variance; 20 bets proves nothing.',
    messages: [{ role: 'user', content: reportMarkdown }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined the review request.');
  return msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
