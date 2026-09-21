/**
 * Insert proposals produced by a Claude Code session.
 *   npm run propose -- --file data/response.json [--kind weekly|adhoc] [--model claude-opus-5]
 * The file must match SlateResponseSchema (src/engine/schema.ts). Games are validated
 * against data/packet-latest.json from the most recent `npm run packet`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { recordSessionSlate, type RunKind } from '../src/engine/run.js';
import { SlateResponseSchema } from '../src/engine/schema.js';
import type { Packet } from '../src/slate.js';

const args = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
const kindIdx = args.indexOf('--kind');
const kind = (kindIdx >= 0 ? args[kindIdx + 1] : 'adhoc') as RunKind;
const modelIdx = args.indexOf('--model');
const model = modelIdx >= 0 ? args[modelIdx + 1] : null; // which Claude produced the picks; the experiment tracks it
if (!file) {
  console.error('usage: npm run propose -- --file <response.json> [--kind weekly|adhoc]');
  process.exit(1);
}
const filePath = [file, path.join(config.repoRoot, file)].find((f) => fs.existsSync(f));
if (!filePath) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}
const response = SlateResponseSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
const packetPath = path.join(config.dataDir, 'packet-latest.json');
if (!fs.existsSync(packetPath)) {
  console.error('No data/packet-latest.json; run `npm run packet` first.');
  process.exit(1);
}
const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8')) as Packet;
const result = recordSessionSlate(kind, packet, response, model);
console.log(JSON.stringify(result, null, 2));
