import cron from 'node-cron';
import { config, hasAnthropicKey } from './config.js';
import { db, getSettings, logEvent } from './db.js';
import { runApiScan } from './engine/run.js';
import { gameInProgress, syncAndGrade } from './grading.js';
import { buildReview } from './review.js';
import { buildPacket } from './slate.js';

/**
 * Every 5 minutes while one of our games is being played, otherwise every 30: refresh any week
 * that still has an ungraded pick (captures line moves, freezes the closing line at kickoff,
 * grades finals). Monday 08:00: lines-only snapshot of the whole slate. Wednesday 10:00: weekly API
 * scan if enabled. Tuesday 08:00: weekly review.
 */
export function startScheduler() {
  const tz = config.displayTz;

  // Each tick is one small ESPN scoreboard request per league with an open pick.
  let lastSync = 0;
  cron.schedule(
    '*/5 * * * *',
    async () => {
      if (!gameInProgress() && Date.now() - lastSync < 29 * 60_000) return;
      lastSync = Date.now();
      try {
        const r = await syncAndGrade();
        if (r.graded) console.log(`[grade] refreshed ${r.refreshed} games, graded ${r.graded}`);
      } catch (e) {
        logEvent('warn', `Scheduled grading failed: ${(e as Error).message}`);
      }
    },
    { timezone: tz },
  );

  cron.schedule(
    '0 10 * * 3',
    async () => {
      if (!getSettings().autoScan || !hasAnthropicKey()) return;
      try {
        await runApiScan('weekly');
      } catch {
        /* logged inside */
      }
    },
    { timezone: tz },
  );

  // Monday 08:00: snapshot the whole upcoming slate (lines only, no per-game detail) so every
  // game has a Monday number on record, not just the ones we end up betting.
  cron.schedule(
    '0 8 * * 1',
    async () => {
      try {
        const p = await buildPacket({ noDetail: true });
        logEvent('info', `Monday line snapshot: ${p.leagues.map((l) => `${l.league} wk ${l.week} ${l.games.length} games`).join(', ')}`);
      } catch (e) {
        logEvent('warn', `Monday line snapshot failed: ${(e as Error).message}`);
      }
    },
    { timezone: tz },
  );

  cron.schedule(
    '0 8 * * 2',
    async () => {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM proposals WHERE graded_at > datetime('now', '-7 days')`).get() as { n: number }).n;
      if (!n) return;
      try {
        await buildReview();
        logEvent('info', 'Weekly review written');
      } catch (e) {
        logEvent('warn', `Weekly review failed: ${(e as Error).message}`);
      }
    },
    { timezone: tz },
  );

  // Catch up once on boot so a machine that was asleep through Sunday grades on startup.
  setTimeout(() => void syncAndGrade().catch((e) => logEvent('warn', `Boot grading failed: ${(e as Error).message}`)), 3000);
}
