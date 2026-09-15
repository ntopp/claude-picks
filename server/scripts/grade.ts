/** Refresh scores for every week with an open pick and settle finals. Also runs every 30 min inside the server. */
import { syncAndGrade } from '../src/grading.js';
import { computeScoreboard } from '../src/stats.js';

const r = await syncAndGrade();
const sb = computeScoreboard();
const pct = (n: number | null) => (n === null ? '-' : `${(n * 100).toFixed(1)}%`);
const u = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}u`;
console.log(`refreshed ${r.refreshed} game(s), graded ${r.graded}`);
console.log(`engine: ${sb.engine.wins}-${sb.engine.losses}-${sb.engine.pushes}  win ${pct(sb.engine.winRate)}  ${u(sb.engine.net)}  ROI ${pct(sb.engine.roi)}  avg CLV ${sb.engine.avgClv?.toFixed(2) ?? '-'}`);
console.log(`you:    ${sb.human.wins}-${sb.human.losses}-${sb.human.pushes}  win ${pct(sb.human.winRate)}  ${u(sb.human.net)}  ROI ${pct(sb.human.roi)}  bankroll ${sb.bankroll.now}u`);
