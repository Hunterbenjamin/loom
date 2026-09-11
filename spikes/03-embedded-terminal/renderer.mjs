// Spike 03 renderer: a grid of terminals backed by node-pty in the main process. The renderer is
// chosen with ?renderer=xterm|ghostty. window.s03 is the hook the Playwright driver uses.
import { FitAddon as XFitAddon } from './node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { Unicode11Addon } from './node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs';
import { UnicodeGraphemesAddon } from './node_modules/@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.mjs';
import { WebglAddon } from './node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs';
import { Terminal as XTerm } from './node_modules/@xterm/xterm/lib/xterm.mjs';
import {
  FitAddon as GFitAddon,
  Terminal as GTerminal,
  init as ghosttyInit,
} from './node_modules/ghostty-web/dist/ghostty-web.js';

const params = new URLSearchParams(location.search);
const RENDERER = params.get('renderer') === 'ghostty' ? 'ghostty' : 'xterm';
const FONT = { fontFamily: 'Menlo, monospace', fontSize: 13 };
const THEME = { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' };

const grid = document.getElementById('grid');
document.getElementById('renderer').textContent = RENDERER;
const status = document.getElementById('status');

const views = new Map();
let seq = 0;
let focusedId = null;
let ghosttyReady = null;
const nextFrame = () =>
  new Promise((r) => {
    requestAnimationFrame(() => r());
    setTimeout(r, 100); // don't hang if the window is occluded and rAF stops
  });
const sleep = (t) => new Promise((r) => setTimeout(r, t));

function layout() {
  const n = Math.max(views.size, 1);
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${Math.ceil(n / cols)}, minmax(0, 1fr))`;
}

async function makeTerm(el) {
  if (RENDERER === 'ghostty') {
    ghosttyReady ??= ghosttyInit();
    await ghosttyReady;
    const term = new GTerminal({ ...FONT, theme: THEME, scrollback: 10000 });
    const fit = new GFitAddon();
    term.loadAddon(fit);
    term.open(el);
    return { term, fit, webgl: false };
  }
  const term = new XTerm({
    ...FONT,
    theme: THEME,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
  });
  const fit = new XFitAddon();
  term.loadAddon(fit);
  if (params.get('graphemes') === '1') {
    term.loadAddon(new UnicodeGraphemesAddon());
    const vs = term.unicode.versions;
    term.unicode.activeVersion = vs.find((v) => v.includes('graphemes')) ?? vs[vs.length - 1];
  } else {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  }
  term.open(el);
  let webgl = false;
  if (params.get('webgl') !== '0') {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
      webgl = true;
    } catch (e) {
      console.warn('webgl failed', e);
    }
  }
  return { term, fit, webgl };
}

function focus(id) {
  focusedId = id;
  for (const v of views.values()) v.cell.classList.toggle('focused', v.id === id);
  views.get(id)?.term.focus();
}

// Key-to-echo latency: set on keydown, resolved by the first parsed write that moves the cursor.
let pendingKey = null;
const latencies = [];
document.addEventListener(
  'keydown',
  (e) => {
    const v = views.get(focusedId);
    if (!v || e.metaKey || e.key.length !== 1) return;
    const b = v.term.buffer.active;
    pendingKey = { id: v.id, t0: performance.now(), x: b.cursorX, y: b.cursorY };
  },
  true,
);

async function open({ file, args = [], env, cwd, title }) {
  const id = `t${++seq}`;
  const cell = document.createElement('div');
  cell.className = 'cell';
  const header = document.createElement('header');
  header.innerHTML = `<span></span><button>close</button>`;
  header.querySelector('span').textContent = title ?? `${file} ${args.join(' ')}`;
  header.querySelector('button').onclick = () => close(id);
  const el = document.createElement('div');
  el.className = 'term';
  cell.append(header, el);
  grid.append(cell);
  layout();
  await nextFrame();

  const { term, fit, webgl } = await makeTerm(el);
  fit.fit();
  const v = {
    id,
    term,
    fit,
    cell,
    webgl,
    title,
    bytesIn: 0,
    parsedBytes: 0,
    exited: null,
    exitedAt: 0,
    spawnedAt: 0,
    lastParsedAt: 0,
    inputLog: [],
    osc52: 0,
  };
  views.set(id, v);

  window.pty.onData(id, (data) => {
    v.bytesIn += data.length;
    if (data.includes('\x1b]52;')) v.osc52++;
    term.write(data, () => {
      v.parsedBytes += data.length;
      v.lastParsedAt = performance.now();
      if (pendingKey?.id === id) {
        const b = term.buffer.active;
        if (b.cursorX !== pendingKey.x || b.cursorY !== pendingKey.y) {
          latencies.push(performance.now() - pendingKey.t0);
          pendingKey = null;
        }
      }
    });
  });
  window.pty.onExit(id, (info) => {
    v.exited = info;
    v.exitedAt = performance.now();
  });
  const send = (d) => {
    v.inputLog.push(d);
    if (v.inputLog.length > 200) v.inputLog.shift();
    window.pty.write(id, d);
  };
  term.onData(send);
  term.onBinary?.(send);
  // ?keyfix=1: neither renderer implements the kitty keyboard protocol Herdr asks for (CSI >5u), so
  // Shift+Enter arrives as a bare CR. Send the kitty/CSI-u encoding ourselves.
  if (params.get('keyfix') === '1') {
    const handled = RENDERER === 'ghostty'; // ghostty-web: return true = handled; xterm: return false
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.type === 'keydown') send('\x1b[13;2u');
        return handled;
      }
      return !handled;
    });
  }
  term.onResize(({ cols, rows }) => window.pty.resize(id, cols, rows));
  new ResizeObserver(() => {
    try {
      fit.fit();
    } catch {}
  }).observe(el);
  cell.addEventListener('mousedown', () => focus(id), true);

  v.spawnedAt = performance.now();
  const { pid } = await window.pty.spawn({ id, file, args, cols: term.cols, rows: term.rows, env, cwd });
  v.pid = pid;
  focus(id);
  status.textContent = `${views.size} terminal(s)`;
  return id;
}

async function close(id) {
  const v = views.get(id);
  if (!v) return;
  await window.pty.kill(id, 'SIGHUP');
  for (let i = 0; i < 50 && !v.exited; i++) await sleep(20);
  window.pty.off(id);
  v.term.dispose();
  v.cell.remove();
  views.delete(id);
  layout();
  status.textContent = `${views.size} terminal(s)`;
  return v.exited;
}

function screenText(id) {
  const v = views.get(id);
  const b = v.term.buffer.active;
  const lines = [];
  for (let y = Math.max(0, b.length - v.term.rows); y < b.length; y++) {
    lines.push(b.getLine(y)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

async function waitFor(id, pattern, timeout = 10000) {
  const re = new RegExp(pattern);
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (re.test(screenText(id))) return performance.now() - t0;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${pattern}\n${screenText(id)}`);
}

// Local flood: run a command in a fresh PTY and time until its output is fully parsed.
async function flood(cmd, timeout = 120000) {
  const id = await open({ file: '/bin/sh', args: ['-c', cmd], title: `flood: ${cmd}` });
  const v = views.get(id);
  const t0 = v.spawnedAt;
  while (!v.exited && performance.now() - t0 < timeout) await sleep(20);
  while (v.parsedBytes < v.bytesIn) await sleep(5);
  await nextFrame();
  const res = {
    cmd,
    bytes: v.bytesIn,
    exitMs: Math.round(v.exitedAt - t0),
    parsedMs: Math.round(v.lastParsedAt - t0),
    MBps: +(v.bytesIn / 1e6 / ((v.lastParsedAt - t0) / 1000)).toFixed(1),
  };
  await close(id);
  return res;
}

// Frame pacing probe: count animation frames over a window (shows main-thread stalls during floods).
async function frameStats(ms) {
  const times = [];
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await nextFrame();
    times.push(performance.now());
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  gaps.sort((a, b) => a - b);
  return {
    frames: times.length,
    fps: +((times.length / ms) * 1000).toFixed(1),
    p50: +gaps[Math.floor(gaps.length * 0.5)]?.toFixed(1),
    p95: +gaps[Math.floor(gaps.length * 0.95)]?.toFixed(1),
    max: +gaps[gaps.length - 1]?.toFixed(1),
  };
}

window.s03 = {
  renderer: RENDERER,
  open,
  close,
  focus,
  screenText,
  waitFor,
  flood,
  frameStats,
  latencies,
  resetLatencies: () => latencies.splice(0),
  ids: () => [...views.keys()],
  info: (id) => {
    const v = views.get(id);
    const b = v.term.buffer.active;
    return {
      id,
      pid: v.pid,
      cols: v.term.cols,
      rows: v.term.rows,
      webgl: v.webgl,
      unicode: v.term.unicode?.activeVersion,
      cursorX: b.cursorX,
      cursorY: b.cursorY,
      bufferType: b.type,
      bufferLength: b.length,
      bytesIn: v.bytesIn,
      exited: v.exited,
      osc52: v.osc52,
      selection: v.term.getSelection?.() ?? null,
    };
  },
  inputLog: (id) => views.get(id).inputLog.map((s) => JSON.stringify(s)),
  clearInputLog: (id) => views.get(id).inputLog.splice(0),
  write: (id, d) => window.pty.write(id, d),
  paste: (id, text) => views.get(id).term.paste(text),
  // A real paste event (what Cmd+V produces) without touching the system clipboard.
  synthPaste: (text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    return document.activeElement.tagName + '.' + document.activeElement.className;
  },
  scrollLines: (id, n) => views.get(id).term.scrollLines(n),
  metrics: () => window.host.metrics(),
};
document.title = `spike 03 · ${RENDERER}`;
