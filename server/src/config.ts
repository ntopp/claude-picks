import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

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
    server: (process.env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/$/, ''),
  },
};

export const hasAnthropicKey = () => !!config.anthropic.apiKey;

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
