import cron from 'node-cron';
import { config, hasAnthropicKey } from './config.js';
import { db, getSettings, logEvent } from './db.js';
import { runApiScan } from './engine/run.js';
import { gameInProgress, syncAndGrade } from './grading.js';
import { buildPacket } from './slate.js';
import { publish } from './publish.js';
import { notify } from './notify.js';

/**
 * Every 5 minutes while one of our games is being played, otherwise every 30: refresh any week
 * that still has an ungraded pick (captures line moves, freezes the closing line at kickoff,
 * grades finals). Monday 08:00: lines-only snapshot of the whole slate and the results publish. Wednesday
 * 10:00: weekly API scan if enabled. Thursday 11:45: warn if the research run has not happened. The Tuesday
 * review is a desktop scheduled task (see CLAUDE.md), not a server job.
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
        // Weekend results are graded by now; refresh the public page and tell the friends topic.
        await publish({ reason: 'results', notify: true });
      } catch (e) {
        logEvent('warn', `Monday line snapshot failed: ${(e as Error).message}`);
      }
    },
    { timezone: tz },
  );

  // Thursday noon: the research run should have produced this week's picks by now. If no weekly run
  // landed today, push a warning instead of letting a hung session go unnoticed for four days.
  cron.schedule(
    '45 11 * * 4',
    async () => {
      const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
      const runs = db.prepare("SELECT started_at FROM runs WHERE kind = 'weekly' ORDER BY id DESC LIMIT 5").all() as { started_at: string }[];
      const ranToday = runs.some((r) => new Date(r.started_at).toLocaleDateString('en-CA', { timeZone: tz }) === todayLocal);
      if (ranToday) return;
      logEvent('warn', 'Thursday research run has not completed by 11:45');
      await notify('Thursday research did not run', 'No picks were proposed today. Open the "Thursday football picks" task in Claude and check for a stuck permission prompt, or click Run now.', { priority: 'high', tags: 'warning' });
    },
    { timezone: tz },
  );

  // Catch up once on boot so a machine that was asleep through Sunday grades on startup.
  setTimeout(() => void syncAndGrade().catch((e) => logEvent('warn', `Boot grading failed: ${(e as Error).message}`)), 3000);
}
