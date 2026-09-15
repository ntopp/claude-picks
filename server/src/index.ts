import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { config, hasAnthropicKey } from './config.js';
import { notifyEnabled } from './notify.js';
import { api } from './routes.js';
import { startScheduler } from './scheduler.js';

const app = express();
app.use(cors({ origin: /^http:\/\/localhost(:\d+)?$/ }));
app.use(express.json({ limit: '5mb' }));

app.use('/api', api);

// Serve the built dashboard if it exists (npm run build in web/), otherwise Vite dev server handles it.
const webDist = path.join(config.repoRoot, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  res.status(500).json({ error: message });
});

// Windows can let a second listener "succeed" while an orphaned child from a previous
// `tsx watch` still owns the port. Probe first so a stale server can never hide behind a fresh banner.
try {
  const probe = await fetch(`http://localhost:${config.port}/api/status`, { signal: AbortSignal.timeout(1500) });
  if (probe.ok) {
    console.error(`\n  Another claude-picks server is already answering on port ${config.port}.`);
    console.error('  Run `npm run stop` first, then start again.\n');
    process.exit(1);
  }
} catch {
  /* nothing listening: good */
}

app.listen(config.port, () => {
  console.log(`claude-picks server on http://localhost:${config.port}  (paper bets only)`);
  console.log(`  Anthropic key: ${hasAnthropicKey() ? 'configured (API engine available)' : 'not set (session engine only)'}`);
  console.log(`  Notifications: ${notifyEnabled() ? 'ntfy on' : 'off (set NTFY_TOPIC)'}`);
  startScheduler();
});
