// Headless probe: run `herdr agent attach` in a PTY, record the raw bytes it emits, and list the
// terminal modes it turns on. Usage:
//   node probe-attach.mjs <target> [--takeover] [--cols 100] [--rows 30] [--ms 3000] [--send <json-string>] [--out file]
import { writeFileSync } from 'node:fs';
import pty from 'node-pty';

const args = process.argv.slice(2);
const target = args[0];
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i === -1 ? def : args[i + 1];
};
const takeover = args.includes('--takeover');
const cols = Number(opt('--cols', 100));
const rows = Number(opt('--rows', 30));
const ms = Number(opt('--ms', 3000));
const send = opt('--send', null);
const out = opt('--out', null);

const attachArgs = ['agent', 'attach', target, ...(takeover ? ['--takeover'] : [])];
const p = pty.spawn('herdr', attachArgs, { cols, rows, env: process.env, name: 'xterm-256color' });
const chunks = [];
let exited = null;
p.onData((d) => chunks.push(d));
p.onExit((e) => {
  exited = e;
});

const sleep = (t) => new Promise((r) => setTimeout(r, t));
await sleep(ms);
if (send) {
  p.write(JSON.parse(send));
  await sleep(ms);
}
const raw = chunks.join('');
if (out) writeFileSync(out, raw);

const modes = {
  altScreen: /\x1b\[\?1049h/.test(raw),
  mouseX10_1000: /\x1b\[\?1000h/.test(raw),
  mouseBtn_1002: /\x1b\[\?1002h/.test(raw),
  mouseAny_1003: /\x1b\[\?1003h/.test(raw),
  mouseSgr_1006: /\x1b\[\?1006h/.test(raw),
  bracketedPaste_2004: /\x1b\[\?2004h/.test(raw),
  focusEvents_1004: /\x1b\[\?1004h/.test(raw),
  kittyKeyboardPush: raw.match(/\x1b\[>\d+u/g) ?? [],
  modifyOtherKeys: raw.match(/\x1b\[>4;\d+m/g) ?? [],
  syncOutput_2026: /\x1b\[\?2026h/.test(raw),
  cursorHidden: /\x1b\[\?25l/.test(raw),
  titleOsc: (raw.match(/\x1b\][012];[^\x07\x1b]*/g) ?? []).slice(0, 3),
};
const privateModes = [...new Set(raw.match(/\x1b\[\?[\d;]+[hl]/g) ?? [])];
console.log(
  JSON.stringify(
    { target, takeover, cols, rows, bytes: raw.length, exited, modes, privateModes },
    null,
    1,
  ),
);
if (!exited) p.kill('SIGHUP');
await sleep(300);
process.exit(0);
