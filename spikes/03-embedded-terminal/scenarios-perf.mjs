// Performance, load, Herdr TUI coexistence and lifecycle scenarios for drive.mjs.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const OUT = path.join(process.env.TMPDIR ?? '/tmp', 'loom-spike-03-embedded-terminal');
const herdr = (...a) => JSON.parse(execFileSync('herdr', a, { encoding: 'utf8' }));
const sh = (cmd) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }).trim();
const attach = (name, extra = []) => ({ file: 'herdr', args: ['agent', 'attach', name, ...extra], title: `attach ${name}` });
const wait = (t) => new Promise((r) => setTimeout(r, t));
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))]?.toFixed(1);
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1) };
};
const FLOODS = ['yes | head -n 2000000', `cat ${path.join(OUT, 'big.txt')}`];

async function openReady(page, name, re, timeout = 15000) {
  const id = await ev(page, (o) => window.s03.open(o), attach(name));
  const t0 = Date.now();
  try {
    await ev(page, ([id, re, t]) => window.s03.waitFor(id, re, t), [id, re, timeout]);
    return { id, ok: true, ms: Date.now() - t0 };
  } catch {
    const text = await ev(page, (id) => window.s03.screenText(id), id);
    const info = await ev(page, (id) => window.s03.info(id), id);
    return { id, ok: false, exited: info.exited, tail: text.trim().split('\n').slice(-2).join(' ') };
  }
}

// Throughput (local PTY vs through Herdr), then key-to-echo latency.
export async function perf({ launch, args, sleep }) {
  const reps = Number(args[0] ?? 3);
  const only = args[1]; // 'herdr': only the through-Herdr throughput part
  const { app, page } = await launch();
  const res = { local: {}, viaHerdr: {}, herdrNoClient: {}, latency: {} };
  for (const cmd of only === 'herdr' ? [] : FLOODS) {
    res.local[cmd] = [];
    for (let i = 0; i < reps; i++) {
      const [f, fr] = await ev(page, (c) => Promise.all([window.s03.flood(c), window.s03.frameStats(2000)]), cmd);
      res.local[cmd].push({ bytes: f.bytes, parsedMs: f.parsedMs, MBps: f.MBps, fpsDuring: fr.fps, maxFrameGapMs: fr.max });
    }
  }
  try {
    execFileSync('herdr', ['pane', 'send-keys', 'w1:p3', 'ctrl+c']);
  } catch {}
  await sleep(500);
  const h = (await openReady(page, 's03-keys', '.', 10000)).id;
  await sleep(1000);
  let n = 100;
  const runInPane = async (cmd, viaClient) => {
    n++;
    const marker = `FLOOD-${n}-DONE`;
    const full = `clear; ${cmd}; echo FLOOD-$((${n}+0))-DONE`; // the typed line never matches the marker
    const b0 = viaClient ? (await ev(page, (id) => window.s03.info(id), h)).bytesIn : 0;
    const t0 = Date.now();
    execFileSync('herdr', ['pane', 'run', 'w1:p3', full]);
    let frames = null;
    let tEnd;
    if (viaClient) {
      // Time the marker's arrival on its own; frameStats runs alongside for a fixed 1.5s window.
      const done = ev(page, ([id, m]) => window.s03.waitFor(id, m, 120000), [h, marker]).then(() => Date.now());
      [frames, tEnd] = await Promise.all([ev(page, () => window.s03.frameStats(1500)), done]);
    } else {
      execFileSync('herdr', ['pane', 'wait-output', 'w1:p3', '--match', marker, '--timeout', '120000']);
      tEnd = Date.now();
    }
    const ms = tEnd - t0;
    const bytes = viaClient ? (await ev(page, (id) => window.s03.info(id), h)).bytesIn - b0 : undefined;
    return { ms, clientBytes: bytes, fpsFirst1500ms: frames?.fps, maxFrameGapMs: frames?.max };
  };
  for (const cmd of FLOODS) {
    res.viaHerdr[cmd] = [];
    for (let i = 0; i < reps; i++) res.viaHerdr[cmd].push(await runInPane(cmd, true));
  }
  await ev(page, (id) => window.s03.close(id), h);
  for (const cmd of FLOODS) {
    res.herdrNoClient[cmd] = [];
    for (let i = 0; i < reps; i++) res.herdrNoClient[cmd].push(await runInPane(cmd, false));
  }

  if (only === 'herdr') {
    await app.close();
    return res;
  }
  // Latency: keydown → first parsed write that moves the cursor.
  const typeN = async (id, count = 30) => {
    await ev(page, (id) => window.s03.focus(id), id);
    await ev(page, () => window.s03.resetLatencies());
    for (let i = 0; i < count; i++) {
      await page.keyboard.type(String.fromCharCode(97 + (i % 26)));
      await sleep(80);
    }
    await sleep(300);
    return stats(await ev(page, () => [...window.s03.latencies]));
  };
  const local = await ev(page, () => window.s03.open({ file: '/bin/cat', title: 'local cat' }));
  await sleep(500);
  res.latency.localCat = await typeN(local);
  await ev(page, (id) => window.s03.close(id), local);
  execFileSync('herdr', ['pane', 'run', 'w1:p3', 'clear; cat']);
  const shellPane = (await openReady(page, 's03-keys', '.', 10000)).id;
  await sleep(800);
  res.latency.herdrCat = await typeN(shellPane);
  await ev(page, (id) => window.s03.close(id), shellPane);
  execFileSync('herdr', ['pane', 'send-keys', 'w1:p3', 'ctrl+c']);
  const c = await openReady(page, 's03-claude', 'for shortcuts');
  await sleep(800);
  res.latency.herdrClaudePrompt = await typeN(c.id);
  for (let i = 0; i < 30; i++) await page.keyboard.press('Backspace');
  await sleep(500);
  await ev(page, (id) => window.s03.close(id), c.id);
  await app.close();
  return res;
}

// CPU and memory with 1 and 6 attached terminals, idle and streaming.
const cpuSeconds = (t) => {
  const [a, b] = t.split(':');
  return Number(a) * 60 + Number(b);
};
function procCpu(pids) {
  if (!pids.length) return {};
  const out = sh(`ps -o pid=,time=,rss= -p ${pids.join(',')} || true`);
  const m = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [pid, time, rss] = line.trim().split(/\s+/);
    m[pid] = { cpu: cpuSeconds(time), rssKB: Number(rss) };
  }
  return m;
}

export async function load({ launch, sleep }) {
  const { app, page } = await launch();
  const serverPid = sh(`pgrep -f 'herdr --session loom-s03 server' | head -1`);
  const sample = async (label, ms = 8000) => {
    const ids = await ev(page, () => window.s03.ids());
    const attachPids = [];
    for (const id of ids) attachPids.push(String((await ev(page, (id) => window.s03.info(id), id)).pid));
    // Also read Electron's own processes from ps, as a cross-check on getAppMetrics' percentCPUUsage.
    const m0 = await ev(page, () => window.s03.metrics()); // also resets Electron's per-process CPU counters
    const electronPids = m0.map((p) => String(p.pid));
    const pids = [...attachPids, serverPid, ...electronPids];
    const before = procCpu(pids);
    await sleep(ms);
    const after = procCpu(pids);
    const m = await ev(page, () => window.s03.metrics());
    const electron = {};
    let cpu = 0;
    let mem = 0;
    for (const p of m) {
      const e = (electron[p.type] ??= { cpuPct: 0, memMB: 0 });
      e.cpuPct += p.cpu.percentCPUUsage;
      e.memMB += p.memory.workingSetSize / 1024;
      cpu += p.cpu.percentCPUUsage;
      mem += p.memory.workingSetSize / 1024;
    }
    for (const e of Object.values(electron)) {
      e.cpuPct = +e.cpuPct.toFixed(1);
      e.memMB = Math.round(e.memMB);
    }
    const pct = (pid) => +(((after[pid]?.cpu ?? 0) - (before[pid]?.cpu ?? 0)) / (ms / 1000) * 100).toFixed(1);
    return {
      label,
      terminals: ids.length,
      electronTotal: {
        cpuPct: +cpu.toFixed(1),
        psCpuPct: +electronPids.reduce((s, p) => s + pct(p), 0).toFixed(1),
        memMB: Math.round(mem),
      },
      electron,
      attachClients: {
        cpuPct: +attachPids.reduce((s, p) => s + pct(p), 0).toFixed(1),
        rssMB: Math.round(attachPids.reduce((s, p) => s + (after[p]?.rssKB ?? 0), 0) / 1024),
      },
      herdrServer: { cpuPct: pct(serverPid), rssMB: Math.round((after[serverPid]?.rssKB ?? 0) / 1024) },
    };
  };
  const streamPanes = ['w1:p3', 'w1:p4', 'w1:p5', 'w1:p6'].filter((p) => {
    try {
      herdr('pane', 'get', p);
      return true;
    } catch {
      return false;
    }
  });
  const stream = (on) => {
    for (const p of streamPanes) {
      if (on) execFileSync('herdr', ['pane', 'run', p, "while :; do date '+%T.%N streaming a line of agent output'; sleep 0.02; done"]);
      else execFileSync('herdr', ['pane', 'send-keys', p, 'ctrl+c']);
    }
  };
  const res = { samples: [], streamPanes };
  try {
    stream(false);
  } catch {}
  await openReady(page, 's03-claude', 'for shortcuts');
  await sleep(2000);
  res.samples.push(await sample('1 terminal, idle (Claude)'));
  const k = await openReady(page, 's03-keys', '.', 10000);
  execFileSync('herdr', ['pane', 'run', 'w1:p3', "while :; do date '+%T.%N streaming a line of agent output'; sleep 0.02; done"]);
  await ev(page, (id) => window.s03.close(id), (await ev(page, () => window.s03.ids()))[0]);
  await sleep(1500);
  res.samples.push(await sample('1 terminal, streaming 50 lines/s'));
  execFileSync('herdr', ['pane', 'send-keys', 'w1:p3', 'ctrl+c']);
  await ev(page, (id) => window.s03.close(id), k.id);
  for (const [name, re] of [
    ['s03-claude', 'for shortcuts'],
    ['s03-codex', 'Ask Codex|›'],
    ['s03-keys', '.'],
    ['s03-x4', '.'],
    ['s03-x5', '.'],
    ['s03-x6', '.'],
  ]) {
    res[`open ${name}`] = (await openReady(page, name, re, 10000)).ok;
  }
  await sleep(2000);
  res.samples.push(await sample('6 terminals, idle'));
  stream(true);
  await sleep(1500);
  res.samples.push(await sample(`6 terminals, ${streamPanes.length} streaming 50 lines/s`));
  stream(false);
  await sleep(500);
  execFileSync('herdr', ['pane', 'run', 'w1:p3', 'yes']);
  await sleep(1500);
  res.samples.push(await sample('6 terminals, 1 flooding (yes)'));
  execFileSync('herdr', ['pane', 'send-keys', 'w1:p3', 'ctrl+c']);
  for (const id of await ev(page, () => window.s03.ids())) await ev(page, (id) => window.s03.close(id), id);
  await app.close();
  return res;
}

// The Herdr TUI and an embedded attach client on the same pane at the same time.
export async function tui({ launch, shot, sleep }) {
  const { app, page } = await launch();
  const res = {};
  const screen = (id) => ev(page, (id) => window.s03.screenText(id), id);
  const info = (id) => ev(page, (id) => window.s03.info(id), id);
  // The TUI refuses to start inside a Herdr pane; the spike driver runs in one, so clear the markers.
  const env = { HERDR_ENV: '0', HERDR_PANE_ID: '', HERDR_TAB_ID: '', HERDR_WORKSPACE_ID: '' };
  const t = await ev(page, (env) => window.s03.open({ file: 'herdr', args: ['--session', 'loom-s03'], env, title: 'Herdr TUI (session loom-s03)' }), env);
  await sleep(3000);
  res.tuiStart = { exited: (await info(t)).exited, firstLines: (await screen(t)).trim().split('\n').slice(0, 3) };
  res.tuiBefore = { showsClaude: /Claude Code|for shortcuts/.test(await screen(t)), pane: herdr('pane', 'get', 'w1:p1').result.pane.scroll, rect: herdr('pane', 'layout', '--pane', 'w1:p1').result.layout.panes.find((p) => p.pane_id === 'w1:p1').rect };
  const a = await openReady(page, 's03-claude', 'for shortcuts');
  res.attachOk = a.ok;
  await sleep(1500);
  const ti = await info(t);
  const ai = await info(a.id);
  res.withBoth = {
    tuiClient: `${ti.cols}x${ti.rows}`,
    attachClient: `${ai.cols}x${ai.rows}`,
    pane: herdr('pane', 'get', 'w1:p1').result.pane.scroll,
    rect: herdr('pane', 'layout', '--pane', 'w1:p1').result.layout.panes.find((p) => p.pane_id === 'w1:p1').rect,
  };
  await shot(page, 'tui-plus-attach');
  await ev(page, (id) => window.s03.focus(id), a.id);
  await page.keyboard.type('seen-in-tui');
  await sleep(1200);
  res.tuiShowsTyping = (await screen(t)).includes('seen-in-tui');
  res.exitedAfterTyping = { tui: (await info(t)).exited, attach: (await info(a.id)).exited };
  await shot(page, 'tui-typing');
  for (let i = 0; i < 11; i++) await page.keyboard.press('Backspace');
  await sleep(500);
  await ev(page, (id) => window.s03.close(id), a.id);
  await sleep(1500);
  res.afterDetach = { pane: herdr('pane', 'get', 'w1:p1').result.pane.scroll, tuiExited: (await info(t)).exited };
  await shot(page, 'tui-after-detach');
  await ev(page, (id) => window.s03.close(id), t);
  await app.close();
  return res;
}

// Close = detach; quit and relaunch; SIGKILL the app and relaunch.
export async function lifecycle({ launch, sleep }) {
  const res = {};
  const targets = [
    ['s03-claude', 'for shortcuts'],
    ['s03-codex', 'Ask Codex|›'],
  ];
  const attachProcs = () => sh(`ps -axo pid,command | grep 'herdr agent attach s03-' | grep -v grep || true`) || 'none';
  const electronProcs = () => sh(`ps -axo pid,command | grep 'Electron.app/Contents/MacOS/Electron' | grep 03-embedded-terminal | grep -v grep | wc -l`);
  const agents = () => herdr('agent', 'list').result.agents.filter((a) => a.name?.startsWith('s03-')).map((a) => `${a.name}:${a.agent_status}`).join(' ');
  const openAll = async (page) => {
    const r = {};
    for (const [n, re] of targets) {
      const o = await openReady(page, n, re);
      r[n] = o.ok ? `ok in ${o.ms}ms` : `FAILED ${JSON.stringify(o.exited)} ${o.tail}`;
    }
    return r;
  };

  let { app, page } = await launch();
  res.firstLaunch = await openAll(page);
  res.attachProcsWhileOpen = attachProcs();
  // Close one terminal from the UI.
  const first = (await ev(page, () => window.s03.ids()))[0];
  res.closeOne = { exit: await ev(page, (id) => window.s03.close(id), first) };
  await sleep(800);
  res.closeOne.agents = agents();
  res.closeOne.attachProcs = attachProcs();
  await app.close();
  await sleep(1500);
  res.afterQuit = { attachProcs: attachProcs(), electronProcs: electronProcs(), agents: agents() };

  ({ app, page } = await launch());
  res.relaunch = await openAll(page);
  const pid = app.process().pid;
  process.kill(pid, 'SIGKILL');
  await sleep(2500);
  res.afterSigkill = { attachProcs: attachProcs(), electronProcs: electronProcs(), agents: agents() };

  ({ app, page } = await launch());
  res.relaunchAfterCrash = await openAll(page);
  await app.close();
  await sleep(1000);
  res.end = { attachProcs: attachProcs(), agents: agents() };
  return res;
}
