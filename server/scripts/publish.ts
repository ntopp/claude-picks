/**
 * Regenerate docs/index.html (the public read-only page), commit and push it if it changed.
 *   npm run publish                 -> manual refresh, no friends push
 *   npm run publish -- --picks      -> "this week's picks are up" push to the friends topic
 *   npm run publish -- --results    -> "results are in" push
 *   npm run publish -- --no-push    -> just write the file
 */
import { publish, renderPage } from '../src/publish.js';
import { config } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--no-push')) {
  const file = path.join(config.repoRoot, 'docs', 'index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await renderPage());
  console.log(`wrote ${file}`);
} else {
  const reason = args.includes('--picks') ? 'picks' : args.includes('--results') ? 'results' : 'manual';
  const changed = await publish({ reason, notify: reason !== 'manual' });
  console.log(changed ? `published (${reason})${config.pagesUrl ? ` -> ${config.pagesUrl}` : ''}` : 'no change since last publish');
}
