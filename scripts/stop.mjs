// Kill every claude-picks server process (and with --all, the dashboard too).
// On Windows, Ctrl+C on `tsx watch` can orphan the child that actually holds the port;
// this finds those by command line and stops them. Usage: npm run stop [-- --all]
import { execFileSync } from 'node:child_process';

const all = process.argv.includes('--all');
const isWin = process.platform === 'win32';

function list() {
  if (isWin) {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    const rows = out ? JSON.parse(out) : [];
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, cmd: r.CommandLine ?? '' }));
  }
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return out
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ pid: Number(l.split(/\s+/)[0]), cmd: l.slice(l.indexOf(' ') + 1) }));
}

const mine = list().filter((p) => /claude-picks/i.test(p.cmd) && !/scripts[\/]stop\.mjs/.test(p.cmd));
const server = mine.filter((p) => /src[\/]index\.ts|server/.test(p.cmd) && !/vite/i.test(p.cmd));
const web = mine.filter((p) => /vite/i.test(p.cmd));
const targets = all ? [...server, ...web] : server;

if (targets.length === 0) {
  console.log('No claude-picks server processes found.');
  process.exit(0);
}
for (const p of targets) {
  try {
    process.kill(p.pid, 'SIGKILL');
    console.log(`stopped ${p.pid}  ${p.cmd.replace(/.*node_modules[\/]/, '').slice(0, 90)}`);
  } catch (e) {
    console.log(`could not stop ${p.pid}: ${e.message}`);
  }
}
if (!all && web.length) console.log(`(dashboard left running; use --all to stop it too)`);
