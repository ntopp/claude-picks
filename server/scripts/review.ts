/**
 * The weekly review, in two halves.
 *   npm run review                          -> print the review packet (last week's picks vs outcomes,
 *                                              leans by confidence, baselines, passes, lessons on file)
 *   npm run review -- --file data/review.json  -> store a review written by a session (ReviewResponseSchema
 *                                              in src/review.ts): narrative + observations + proposals
 *   npm run review -- --api                 -> run the whole review through the API engine (needs a key)
 *   npm run review -- --auto                -> stats-only review, no engine
 *   npm run review -- --lessons             -> list lessons on file
 *   npm run review -- --adopt 3 | --reject 3  -> decide a proposed playbook change
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { db, listLessons, logEvent } from '../src/db.js';
import { buildReview, buildReviewPacket, readReviewFile, runApiReview, storeReview } from '../src/review.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--lessons')) {
  for (const l of listLessons(50)) console.log(`#${l.id} [${l.kind}${l.kind === 'proposal' ? `, ${l.status}` : ''}] ${l.text}${l.evidence ? `\n    evidence: ${l.evidence}` : ''}`);
} else if (flag('--adopt') || flag('--reject')) {
  const id = Number(flag('--adopt') ?? flag('--reject'));
  const status = flag('--adopt') ? 'adopted' : 'rejected';
  const r = db.prepare("UPDATE lessons SET status = ? WHERE id = ? AND kind = 'proposal'").run(status, id);
  if (!r.changes) {
    console.error(`No proposal #${id}`);
    process.exit(1);
  }
  logEvent('info', `Lesson #${id} marked ${status}`);
  console.log(`proposal #${id} ${status}`);
} else if (flag('--file')) {
  const file = flag('--file')!;
  const filePath = [file, path.join(config.repoRoot, file)].find((f) => fs.existsSync(f));
  if (!filePath) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  const r = storeReview(readReviewFile(filePath));
  logEvent('info', `Review #${r.id} stored with ${r.lessons} lesson(s)`);
  console.log(JSON.stringify(r));
} else if (args.includes('--api')) {
  const r = await runApiReview();
  console.log(JSON.stringify(r));
} else if (args.includes('--auto')) {
  const r = await buildReview();
  console.log(r.report);
} else {
  console.log(buildReviewPacket());
}
