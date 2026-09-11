// Two attach clients on one agent: does the second evict the first, and whose size wins?
// Usage: node probe-two-clients.mjs <target> [--takeover-b] [--a 100x30] [--b 70x20]
import { execFileSync } from 'node:child_process';
import pty from 'node-pty';

const args = process.argv.slice(2);
const target = args[0];
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const [aCols, aRows] = opt('--a', '100x30').split('x').map(Number);
const [bCols, bRows] = opt('--b', '70x20').split('x').map(Number);
const takeoverB = args.includes('--takeover-b');
const sleep = (t) => new Promise((r) => setTimeout(r, t));

function client(name, cols, rows, extra = []) {
  const c = { name, bytes: 0, exited: null, tail: '' };
  c.p = pty.spawn('herdr', ['agent', 'attach', target, ...extra], { cols, rows, env: process.env });
  c.p.onData((d) => {
    c.bytes += d.length;
    c.tail = (c.tail + d).slice(-400);
  });
  c.p.onExit((e) => {
    c.exited = e;
  });
  return c;
}

// The pane's real size, as the program inside it sees it.
function paneSize() {
  const pane = JSON.parse(execFileSync('herdr', ['pane', 'get', target.includes(':') ? target : paneOf(target)])).result.pane;
  return pane.scroll ? `viewport_rows=${pane.scroll.viewport_rows}` : JSON.stringify(pane).slice(0, 200);
}
function paneOf(name) {
  return JSON.parse(execFileSync('herdr', ['agent', 'get', name])).result.agent.pane_id;
}
const snap = (label, a, b) =>
  console.log(
    label.padEnd(28),
    `A bytes=${a.bytes} exited=${JSON.stringify(a.exited)}`,
    b ? `| B bytes=${b.bytes} exited=${JSON.stringify(b.exited)}` : '',
    '|',
    paneSize(),
  );

console.log('before any client'.padEnd(28), paneSize());
const a = client('A', aCols, aRows);
await sleep(1500);
snap(`A attached ${aCols}x${aRows}`, a);
const b = client('B', bCols, bRows, takeoverB ? ['--takeover'] : []);
await sleep(1500);
snap(`B attached ${bCols}x${bRows}${takeoverB ? ' --takeover' : ''}`, a, b);
// Nudge output so both clients get a frame, then compare byte counts.
const a0 = a.bytes;
const b0 = b.bytes;
a.p.write('x');
await sleep(800);
snap('A typed "x"', a, b);
console.log(`  A received ${a.bytes - a0} bytes, B received ${b.bytes - b0} bytes after A typed`);
const a1 = a.bytes;
const b1 = b.bytes;
b.p.write('y');
await sleep(800);
snap('B typed "y"', a, b);
console.log(`  A received ${a.bytes - a1} bytes, B received ${b.bytes - b1} bytes after B typed`);
a.p.write('\x7f\x7f'); // erase the two test characters
await sleep(500);
if (!b.exited) b.p.kill('SIGHUP');
await sleep(1000);
snap('B closed', a, b);
if (!a.exited) a.p.kill('SIGHUP');
await sleep(1000);
snap('A closed', a, b);
console.log('A tail:', JSON.stringify(a.tail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-200)));
console.log('B tail:', JSON.stringify(b.tail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-200)));
process.exit(0);
