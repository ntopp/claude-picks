// Starts the server and the dashboard together. Used by `npm start`. Logs go to data/logs/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logDir = path.join(root, 'data', 'logs');
fs.mkdirSync(logDir, { recursive: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (name, args) => {
  const out = fs.openSync(path.join(logDir, `${name}.log`), 'a');
  const child = spawn(npm, args, { cwd: root, stdio: ['ignore', out, out], shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    fs.writeSync(out, `\n[${new Date().toISOString()}] ${name} exited with ${code}; restarting in 10s\n`);
    setTimeout(() => run(name, args), 10_000);
  });
  return child;
};

run('server', ['run', 'dev:server']);
run('web', ['run', 'dev:web']);
console.log(`claude-picks running. Dashboard: http://localhost:5174  Logs: ${logDir}`);
