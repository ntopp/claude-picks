/**
 * Print the weekly packet. Used by a Claude Code session as the "session engine":
 *   npm run packet                      -> markdown to stdout, JSON to data/packet-latest.json
 *   npm run packet -- --league nfl      -> one league only (nfl | cfb)
 *   npm run packet -- --week 3          -> a specific week (applies to every league requested)
 *   npm run packet -- --all-detail      -> injuries / last five for every college game too
 *   npm run packet -- --no-detail       -> lines only, fast
 *   npm run packet -- --focus id,id     -> force detail for these ESPN event ids
 *   npm run packet -- --json            -> print JSON instead of markdown
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, LEAGUES, type League } from '../src/config.js';
import { buildPacket, renderPacketMarkdown } from '../src/slate.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const leagueArg = flag('--league');
const leagues = leagueArg ? (leagueArg.split(',') as League[]) : LEAGUES;
for (const l of leagues) if (!LEAGUES.includes(l)) throw new Error(`unknown league ${l}`);
const weekArg = flag('--week');
const week = weekArg ? Object.fromEntries(leagues.map((l) => [l, Number(weekArg)])) : undefined;

const packet = await buildPacket({
  leagues,
  week,
  detailAll: args.includes('--all-detail'),
  noDetail: args.includes('--no-detail'),
  focus: flag('--focus')?.split(','),
});
fs.writeFileSync(path.join(config.dataDir, 'packet-latest.json'), JSON.stringify(packet, null, 2));
if (args.includes('--json')) console.log(JSON.stringify(packet, null, 2));
else console.log(renderPacketMarkdown(packet, config.displayTz));
