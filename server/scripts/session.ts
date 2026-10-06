/**
 * The weekly session jobs as single commands, so a scheduled Claude Code session only ever runs bare
 * `npm run <name>` commands (pre-approved) and reads/writes files in data/ — no pipes, redirects or cd.
 *
 *   npm run picks:start [-- --league nfl|cfb]   -> data/packet-latest.md (+ .json): the weekly packet to read
 *   npm run picks:finish -- --model <id>        -> data/response.json through the rails, then publish + friends push
 *                           [--kind adhoc]         (default kind weekly)
 *   npm run review:start                        -> grade everything, then data/review-packet.md to read
 *   npm run review:finish                       -> store data/review.json, then publish (no friends push)
 *
 * Each prints a short summary; the long material goes to the files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, LEAGUES, type League } from '../src/config.js';
import { logEvent } from '../src/db.js';
import { recordSessionSlate, type RunKind } from '../src/engine/run.js';
import { SlateResponseSchema } from '../src/engine/schema.js';
import { syncAndGrade } from '../src/grading.js';
import { publish } from '../src/publish.js';
import { buildReviewPacket, readReviewFile, storeReview } from '../src/review.js';
import { buildPacket, renderPacketMarkdown, type Packet } from '../src/slate.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const data = (f: string) => path.join(config.dataDir, f);
const rel = (f: string) => path.relative(config.repoRoot, f).replaceAll('\\', '/');
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

async function picksStart() {
  // --league nfl | cfb for one league (the Thursday task is NFL, the Friday task college). College always gets
  // full detail on every game: ESPN carries no college injury data, so the rest has to come from research.
  const leagueArg = flag('--league');
  if (leagueArg && !LEAGUES.includes(leagueArg as League)) fail(`unknown league ${leagueArg} (use nfl or cfb)`);
  const leagues = leagueArg ? [leagueArg as League] : LEAGUES;
  const packet = await buildPacket({ leagues, detailAll: leagues.includes('cfb') });
  const md = renderPacketMarkdown(packet, config.displayTz);
  fs.writeFileSync(data('packet-latest.json'), JSON.stringify(packet, null, 2));
  fs.writeFileSync(data('packet-latest.md'), md);
  for (const l of packet.leagues) console.log(`${l.league.toUpperCase()} week ${l.week}: ${l.games.length} games, ${l.games.filter((g) => g.lines).length} with a line`);
  console.log(`Packet written to ${rel(data('packet-latest.md'))} (${md.split('\n').length} lines). Read it in full, then write ${rel(data('response.json'))}.`);
}

async function picksFinish() {
  const model = flag('--model') ?? fail('usage: npm run picks:finish -- --model <exact model id from your system prompt>');
  const kind = (flag('--kind') ?? 'weekly') as RunKind;
  const file = data('response.json');
  if (!fs.existsSync(file)) fail(`No ${rel(file)}; write the slate response there first.`);
  if (!fs.existsSync(data('packet-latest.json'))) fail('No packet; run `npm run picks:start` first.');
  const parsed = SlateResponseSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) fail(`${rel(file)} does not match SlateResponseSchema:\n${parsed.error.message}`);
  const packet = JSON.parse(fs.readFileSync(data('packet-latest.json'), 'utf8')) as Packet;
  const result = recordSessionSlate(kind, packet, parsed.data!, model);
  console.log(`Run #${result.runId}: ${result.inserted.length} pick(s) inserted, ${result.dropped.length} dropped.`);
  for (const d of result.dropped) console.log(`  dropped ${d.pick}: ${d.reason}`);
  // The friends push ("picks are up") only when there is something new to look at, named by league.
  const only = packet.leagues.length === 1 ? packet.leagues[0].league : null;
  const title = only === 'cfb' ? 'College picks are up' : only === 'nfl' ? 'NFL picks are up' : undefined;
  const changed = await publish({ reason: 'picks', notify: result.inserted.length > 0, title });
  console.log(changed ? `Public page published${result.inserted.length ? ' and friends notified' : ''}.` : 'Public page unchanged.');
}

async function reviewStart() {
  const g = await syncAndGrade();
  const md = buildReviewPacket();
  fs.writeFileSync(data('review-packet.md'), md);
  console.log(`Graded: refreshed ${g.refreshed} games, settled ${g.graded} pick(s) and ${g.leansGraded} lean(s).`);
  console.log(`Review packet written to ${rel(data('review-packet.md'))} (${md.split('\n').length} lines). Read it in full, then write ${rel(data('review.json'))}.`);
}

async function reviewFinish() {
  const file = data('review.json');
  if (!fs.existsSync(file)) fail(`No ${rel(file)}; write the review there first.`);
  const r = storeReview(readReviewFile(file));
  logEvent('info', `Review #${r.id} stored with ${r.lessons} lesson(s)`);
  console.log(`Review #${r.id} stored with ${r.lessons} lesson(s).`);
  const changed = await publish({ reason: 'manual', notify: false });
  console.log(changed ? 'Public page published (no friends push).' : 'Public page unchanged.');
}

const COMMANDS: Record<string, () => Promise<void>> = {
  'picks-start': picksStart,
  'picks-finish': picksFinish,
  'review-start': reviewStart,
  'review-finish': reviewFinish,
};
const run = COMMANDS[cmd ?? ''] ?? (() => fail(`usage: session.ts ${Object.keys(COMMANDS).join(' | ')}`));
await run();
