/**
 * Cheap preflight for the API engine: one tiny call to confirm the key, the model and structured
 * output all work, before a real scan spends money. Prints the model that answered and the tokens used.
 *   npm run engine:check
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config, hasAnthropicKey } from '../src/config.js';

if (!hasAnthropicKey()) {
  console.error('ANTHROPIC_API_KEY is not set in .env — add it, then run this again.');
  process.exit(1);
}
const Schema = z.object({ ok: z.boolean(), sport: z.string() });
const client = new Anthropic({ apiKey: config.anthropic.apiKey });
try {
  const msg = await client.beta.messages.create({
    model: config.anthropic.model,
    max_tokens: 200,
    messages: [{ role: 'user', content: 'Reply with ok=true and sport="football".' }],
    output_config: { format: zodOutputFormat(Schema) },
  });
  const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
  Schema.parse(JSON.parse(text));
  console.log(`engine OK — model ${msg.model}, ${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out`);
  console.log(`web search on scans: ${'enabled via the webSearch setting'}`);
} catch (e) {
  console.error(`engine check FAILED: ${(e as Error).message}`);
  process.exit(1);
}
