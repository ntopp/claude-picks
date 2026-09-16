import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { execFileSync } from 'node:child_process';

// Load the repo-root .env regardless of where the process was started from.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env') });

export const config = {
  repoRoot,
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(repoRoot, 'data'),
  port: Number(process.env.PORT ?? 8788),
  displayTz: process.env.DISPLAY_TZ ?? 'America/Chicago',

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.CLAUDE_MODEL ?? 'claude-opus-5',
  },

  ntfy: {
    topic: (process.env.NTFY_TOPIC ?? '').trim(),
    friendsTopic: (process.env.NTFY_FRIENDS_TOPIC ?? '').trim(), // picks-only pushes for people following along
    server: (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, ''),
  },

  /** Where a phone opens the dashboard; used as the tap-through link on pushes. Set DASHBOARD_URL or let Tailscale be detected. */
  dashboardUrl: (process.env.DASHBOARD_URL ?? '').trim().replace(/\/$/, '') || detectDashboardUrl(),
  webPort: Number(process.env.WEB_PORT ?? 5174),

  /** Public read-only page (GitHub Pages). Blank disables the friends pushes; the page is still generated. */
  pagesUrl: (process.env.PAGES_URL ?? '').trim(),
};

export const hasAnthropicKey = () => !!config.anthropic.apiKey;

/** Best effort: the machine's Tailscale IPv4 (100.x.y.z) if the CLI is installed, else localhost. */
function detectDashboardUrl(): string {
  const port = Number(process.env.WEB_PORT ?? 5174);
  const candidates = process.platform === 'win32' ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'] : ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const bin of candidates) {
    try {
      const ip = execFileSync(bin, ['ip', '-4'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/)[0];
      if (/^100\.\d+\.\d+\.\d+$/.test(ip)) return `http://${ip}:${port}`;
    } catch {
      /* not installed or not running */
    }
  }
  return `http://localhost:${port}`;
}

fs.mkdirSync(config.dataDir, { recursive: true });

export type League = 'nfl' | 'cfb';
export const LEAGUES: League[] = ['nfl', 'cfb'];
export const LEAGUE_LABEL: Record<League, string> = { nfl: 'NFL', cfb: 'College' };

/**
 * Bankroll rails. Stored in the settings table so they can be tuned from the UI.
 * Everything is paper: a "unit" is the accounting currency, unitDollars only decorates the display.
 */
export const DEFAULT_SETTINGS = {
  unitDollars: 100, // display only: what 1u would be if this were real money
  bankrollUnits: 100, // starting paper bankroll, in units
  defaultUnits: 1, // stake for an ordinary pick
  maxUnitsPerBet: 2, // the engine may size up to this for its strongest ideas
  maxPicksPerWeek: 12, // across both leagues; the insert path drops extras (lowest confidence first)
  minConfidence: 5, // proposals under this are dropped at insert
  lineTolerance: 1.5, // points: a proposal whose line differs from the current line by more is dropped (stale packet)
  maxFavoritePrice: -250, // moneyline favorites shorter than this are dropped (no edge at -300)
  autoScan: false, // run the weekly API scan on a schedule (needs ANTHROPIC_API_KEY)
  webSearch: true, // let the API engine research injuries / coaching / news with web search
};
export type Settings = typeof DEFAULT_SETTINGS;
