// Spike 03 test app: Electron main process. Owns node-pty processes and serves the renderer over a
// loopback HTTP server so ES modules and wasm load without file:// restrictions.
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const pty = require('node-pty');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const file = path.join(ROOT, decodeURIComponent(url.pathname));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Keep rendering when the window is behind other windows (macOS occlusion stops rAF otherwise),
// so automated runs behave like a visible window.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// id -> { proc, buf, timer }
const ptys = new Map();

function flush(win, id) {
  const p = ptys.get(id);
  if (!p || p.buf.length === 0) return;
  const data = p.buf.join('');
  p.buf = [];
  p.timer = null;
  if (!win.isDestroyed()) win.webContents.send('pty:data', id, data);
}

function wire(win) {
  ipcMain.handle('pty:spawn', (_e, { id, file, args, cols, rows, cwd, env }) => {
    const proc = pty.spawn(file, args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd ?? process.env.HOME,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...(env ?? {}) },
    });
    const entry = { proc, buf: [], timer: null };
    ptys.set(id, entry);
    // Coalesce chunks for ~4ms so a flood doesn't become thousands of IPC messages.
    proc.onData((d) => {
      entry.buf.push(d);
      if (!entry.timer) entry.timer = setTimeout(() => flush(win, id), 4);
    });
    proc.onExit(({ exitCode, signal }) => {
      flush(win, id);
      ptys.delete(id);
      if (!win.isDestroyed()) win.webContents.send('pty:exit', id, { exitCode, signal });
    });
    return { pid: proc.pid };
  });
  ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.proc.write(data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => {
    try {
      ptys.get(id)?.proc.resize(cols, rows);
    } catch {}
  });
  // Closing a terminal: SIGHUP the attach client, like closing a terminal window would.
  ipcMain.handle('pty:kill', (_e, id, signal) => {
    const p = ptys.get(id);
    if (!p) return false;
    p.proc.kill(signal ?? 'SIGHUP');
    return true;
  });
  ipcMain.handle('pty:list', () => [...ptys.entries()].map(([id, p]) => ({ id, pid: p.proc.pid })));
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(text));
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('app:metrics', () => app.getAppMetrics());
}

app.whenReady().then(async () => {
  const port = await serve();
  const win = new BrowserWindow({
    width: Number(process.env.S03_WIDTH ?? 1400),
    height: Number(process.env.S03_HEIGHT ?? 900),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  wire(win);
  const renderer = process.env.S03_RENDERER ?? 'xterm';
  const extra = process.env.S03_QUERY ? `&${process.env.S03_QUERY}` : '';
  await win.loadURL(`http://127.0.0.1:${port}/index.html?renderer=${renderer}${extra}`);
  // Quitting the app kills every PTY (SIGHUP), which must only detach the attach clients.
  app.on('before-quit', () => {
    for (const p of ptys.values()) p.proc.kill('SIGHUP');
  });
});

app.on('window-all-closed', () => app.quit());
