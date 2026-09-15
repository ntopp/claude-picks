/** Run the API engine end to end: packet -> Claude (web search) -> red team -> proposals. Needs ANTHROPIC_API_KEY. */
import { LEAGUES, type League } from '../src/config.js';
import { runApiScan } from '../src/engine/run.js';

const args = process.argv.slice(2);
const noteIdx = args.indexOf('--note');
const leagueIdx = args.indexOf('--league');
const leagues = leagueIdx >= 0 ? (args[leagueIdx + 1].split(',') as League[]) : LEAGUES;
const result = await runApiScan(args.includes('--weekly') ? 'weekly' : 'adhoc', { userNote: noteIdx >= 0 ? args[noteIdx + 1] : undefined, leagues });
console.log(JSON.stringify(result, null, 2));
