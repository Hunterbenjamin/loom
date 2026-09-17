// The Electron main process. It owns the window and the PTYs behind the Terminal tab, and
// no durable task state: the coordinator remains the owner.
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  shell,
} from "electron";
import { z } from "zod";
import { connectionFromEnvironment } from "../shared/connection.js";
import {
  type PtyExit,
  type PtySpawnResult,
  ptySpawnRequest,
  type WindowMode,
  windowMode,
} from "../shared/ipc.js";
import { usesWorkbenchKey } from "../shared/keybindings.js";
import { resolveAttach } from "./attach.js";
import { devControls, restartsApp, syncSummary } from "./dev-control.js";
import { watchKeybindings } from "./keybindings.js";
import { readNativeSettings, writeNativeSettings } from "./native-settings.js";
import { OwnedResources } from "./ownership.js";
import {
  type PaneHost,
  paneHostOf,
  paneOnAlternateScreen,
  readPaneHistory,
} from "./pane-history.js";
import { repositoryFolder } from "./repository.js";
import { syncWindowChrome } from "./window-chrome.js";

ipcMain.handle("app:choose-repository", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error("Window is unavailable");
  const result = await dialog.showOpenDialog(owner, {
    title: "Open repository",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return repositoryFolder(result.filePaths[0]);
});

const connection = connectionFromEnvironment(process.env);

// node-pty is a native CommonJS addon; electron-vite externalizes it, so require it directly.
const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

// A window Chromium thinks is covered stops requestAnimationFrame, which stalls both the
// terminal and the Playwright harness (spike 03).
// A DevTools port for driving the dev app from a script (Playwright over CDP); dev only.
if (process.env.LOOM_DEBUG_PORT)
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.LOOM_DEBUG_PORT,
  );
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

interface Session {
  proc: import("node-pty").IPty;
  chunks: string[];
  timer: NodeJS.Timeout | null;
  lastFlush: number;
  /** The tmux pane behind an attach, for its history and its alternate-screen state. */
  pane: PaneHost | null;
  /** Output is held back until the pane's history has been replayed ahead of it. */
  holding: boolean;
}

const notified = new Set<string>();
ipcMain.on("app:notify", (_event, raw: unknown) => {
  const parsed = z
    .strictObject({
      id: z.string().max(10000),
      title: z.string().max(200),
      body: z.string().max(8000),
    })
    .safeParse(raw);
  if (!parsed.success || notified.has(parsed.data.id)) return;
  notified.add(parsed.data.id);
  if (notified.size > 10000)
    notified.delete(notified.values().next().value as string);
  if (Notification.isSupported())
    new Notification({
      title: parsed.data.title,
      body: parsed.data.body,
    }).show();
});
const sessions = new OwnedResources<Session>((session) => {
  if (session.timer) clearTimeout(session.timer);
  session.proc.kill("SIGHUP");
});
const windows = new Map<number, { window: BrowserWindow; mode: WindowMode }>();
const startupSettings = readNativeSettings(process.env);
const keybindings = watchKeybindings(process.env, (state) => {
  for (const { window } of windows.values()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send("app:keybindings-changed", state);
  }
});
async function openWindow(mode: WindowMode) {
  await createWindow(mode);
}
function setWindowMode(
  entry: { window: BrowserWindow; mode: WindowMode },
  mode: WindowMode,
) {
  if (entry.mode === mode) return;
  entry.mode = mode;
  entry.window.webContents.setIgnoreMenuShortcuts(false);
  entry.window.webContents.send("app:mode-changed", mode);
}
function owned(sender: Electron.WebContents) {
  const entry = windows.get(sender.id);
  if (!entry || entry.window.isDestroyed() || sender.isDestroyed())
    throw new Error("Unknown window");
  return entry;
}

function flush(window: BrowserWindow, id: string): void {
  const session = sessions.get(window.webContents.id, id);
  if (!session || session.holding || session.chunks.length === 0) return;
  const data = session.chunks.join("");
  session.chunks = [];
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  session.lastFlush = Date.now();
  if (!window.isDestroyed()) window.webContents.send("pty:data", id, data);
}

const controls = devControls(app.getAppPath(), app.isPackaged, process.env);

/** Pulls main when safe and restarts whatever is stale. When the script restarts this app, the
 * old instance quits without a word: the new window is the one to read. Otherwise say what
 * happened, including why nothing was pulled. */
async function updateAndRestart() {
  const report = join(
    process.env.LOOM_DATA_ROOT
      ? join(process.env.LOOM_DATA_ROOT, process.env.LOOM_INSTANCE ?? "dev")
      : app.getPath("temp"),
    "dev-control-sync.log",
  );
  try {
    const output = await controls.runAndReport("sync", report);
    if (quitting || restartsApp(output)) {
      app.quit();
      return;
    }
    const { title, detail } = syncSummary(output);
    await dialog.showMessageBox({ message: title, detail });
  } catch (error) {
    dialog.showErrorBox(
      "Loom couldn't update",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function wire(): void {
  ipcMain.handle("app:dev-control-available", (event) => {
    owned(event.sender);
    return controls.available();
  });
  ipcMain.handle("app:dev-control", (event, raw: unknown) => {
    owned(event.sender);
    return controls.run(raw);
  });
  ipcMain.handle("app:keybindings", (event) => {
    owned(event.sender);
    return keybindings.get();
  });
  ipcMain.handle("app:apply-native-settings", (event, raw: unknown) => {
    owned(event.sender);
    const settings = writeNativeSettings(process.env, raw);
    keybindings.set(settings.keybindings);
  });
  ipcMain.handle("app:connection", (event) => {
    owned(event.sender);
    return connection;
  });
  ipcMain.handle("app:mode", (event) => owned(event.sender).mode);
  ipcMain.handle("app:start-dictation", (event) => {
    owned(event.sender);
    if (process.platform !== "darwin") return;
    Menu.sendActionToFirstResponder("startDictation:");
  });
  ipcMain.handle("app:set-mode", (event, raw: unknown) => {
    setWindowMode(owned(event.sender), windowMode.parse(raw));
  });
  ipcMain.handle("app:open-window", async (event, raw: unknown) => {
    owned(event.sender);
    await openWindow(windowMode.parse(raw));
  });
  ipcMain.handle(
    "pty:spawn",
    async (event, raw: unknown): Promise<PtySpawnResult> => {
      const { window } = owned(event.sender);
      const request = ptySpawnRequest.parse(raw);
      const token = sessions.begin(event.sender.id, request.id);
      const target = request.shellKey
        ? await resolveAttach(connection, {
            shellKey: request.shellKey,
            shellName: request.shellName,
          })
        : request.pane
          ? await resolveAttach(connection, request.pane)
          : request.lead
            ? await resolveAttach(connection, { lead: request.lead })
            : request.runId
              ? await resolveAttach(connection, request.runId)
              : null;
      if (!target?.attach)
        throw new Error("Select a run with a live terminal pane");
      if (window.isDestroyed()) throw new Error("Window closed");
      owned(event.sender);
      const resolved = target.attach;
      const file = resolved.argv[0] as string;
      const args = resolved.argv.slice(1);
      const proc = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: request.cols,
        rows: request.rows,
        cwd: resolved.cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "",
          LANG: process.env.LANG ?? "en_US.UTF-8",
          ...(process.env.TMUX_TMPDIR
            ? { TMUX_TMPDIR: process.env.TMUX_TMPDIR }
            : {}),
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      });
      const pane = paneHostOf(resolved.argv, target.pane?.paneId);
      const history = request.history;
      const replay = pane !== null && (history?.lines ?? 0) > 0;
      const session: Session = {
        proc,
        chunks: [],
        timer: null,
        lastFlush: 0,
        pane,
        holding: replay,
      };
      if (!sessions.finish(event.sender.id, request.id, token, session))
        throw new Error("Panel closed");
      // The host resizes the pane to this client as it attaches, which moves lines between
      // the screen and the history; so the history is read once the first redraw is in, and
      // that redraw waits for it, so the viewer gets history first and the live screen after.
      const release = (history: string) => {
        if (!session.holding) return;
        session.holding = false;
        if (sessions.get(event.sender.id, request.id) !== session) return;
        if (history && !window.isDestroyed())
          window.webContents.send("pty:history", request.id, history);
        flush(window, request.id);
      };
      let capturing = false;
      // Coalesce for a frame, so a flood is a handful of IPC messages instead of thousands.
      proc.onData((data) => {
        if (sessions.get(event.sender.id, request.id) !== session) return;
        session.chunks.push(data);
        if (session.holding) {
          if (capturing || !pane || !history) return;
          capturing = true;
          const timer = setTimeout(() => release(""), 2_000);
          void readPaneHistory(pane, history)
            .catch((error: unknown) => {
              console.warn(`pane history for ${pane.paneId}: ${String(error)}`);
              return "";
            })
            .then((history) => {
              clearTimeout(timer);
              release(history);
            });
          return;
        }
        if (Date.now() - session.lastFlush > 8) flush(window, request.id);
        else if (!session.timer)
          session.timer = setTimeout(() => flush(window, request.id), 4);
      });
      proc.onExit(({ exitCode, signal }) => {
        if (sessions.get(event.sender.id, request.id) !== session) return;
        session.holding = false;
        flush(window, request.id);
        sessions.delete(event.sender.id, request.id, session);
        const info: PtyExit = { exitCode, signal: signal ?? 0 };
        if (!window.isDestroyed())
          window.webContents.send("pty:exit", request.id, info);
      });
      return { pid: proc.pid, command: [file, ...args].join(" ") };
    },
  );

  ipcMain.on("pty:write", (event, id: string, data: string) => {
    if (!windows.has(event.sender.id) || event.sender.isDestroyed()) return;
    if (
      typeof id !== "string" ||
      typeof data !== "string" ||
      data.length > 1048576
    )
      return;
    sessions.get(event.sender.id, id)?.proc.write(data);
  });

  ipcMain.on("pty:resize", (event, id: string, cols: number, rows: number) => {
    if (!windows.has(event.sender.id) || event.sender.isDestroyed()) return;
    if (![cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000))
      return;
    try {
      sessions.get(event.sender.id, id)?.proc.resize(cols, rows);
    } catch {
      // The process can exit between the resize event and this call.
    }
  });

  // Closing a panel detaches, exactly like closing a terminal window: SIGHUP, and the agent
  // behind an attach keeps running (spike 03).
  ipcMain.handle("pty:pane-flags", async (event, id: string) => {
    owned(event.sender);
    const pane =
      typeof id === "string" ? sessions.get(event.sender.id, id)?.pane : null;
    if (!pane) return { alternate: false };
    return {
      alternate: await paneOnAlternateScreen(pane).catch(() => false),
    };
  });

  ipcMain.handle("pty:kill", (event, id: string) => {
    owned(event.sender);
    return sessions.kill(event.sender.id, id);
  });

  // The cold-start measurement spawns this app directly and reads this line, so the number
  // is the app's own start-up and not Playwright's debugger attaching.
  let reported = false;
  ipcMain.on("app:interactive", (event) => {
    owned(event.sender);
    if (reported) return;
    reported = true;
    process.stdout.write(`loom:interactive ${Date.now()}\n`);
    if (process.env.LOOM_EXIT_WHEN_INTERACTIVE) app.quit();
  });

  ipcMain.handle("app:metrics", () =>
    app.getAppMetrics().map((m) => ({
      type: m.type,
      cpu: { percentCPUUsage: m.cpu.percentCPUUsage },
    })),
  );
}

async function createWindow(mode: WindowMode): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    show: true,
    width: Number(process.env.LOOM_WIDTH ?? 1440),
    height: Number(process.env.LOOM_HEIGHT ?? 900),
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0e0f11",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  syncWindowChrome(window);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = z.url().safeParse(url);
    if (parsed.success && /^https?:\/\//i.test(parsed.data))
      void shell.openExternal(parsed.data);
    return { action: "deny" };
  });
  const owner = window.webContents.id;
  windows.set(owner, { window, mode });
  sessions.open(owner);
  const cleanup = () => {
    sessions.close(owner);
    windows.delete(owner);
    if (!windows.size) app.quit();
  };
  window.on("closed", cleanup);
  window.webContents.on("render-process-gone", cleanup);
  window.webContents.on("before-input-event", (event, input) => {
    // Cmd+W otherwise invokes Electron's native Close Window menu role before
    // Workbench sees it. Keep unbound editing/menu shortcuts working normally.
    window.webContents.setIgnoreMenuShortcuts(
      windows.get(owner)?.mode === "workbench" &&
        usesWorkbenchKey(keybindings.get().config, {
          key: input.key,
          ctrlKey: input.control,
          metaKey: input.meta,
          altKey: input.alt,
          shiftKey: input.shift,
        }),
    );
    if (
      input.type === "keyDown" &&
      input.meta &&
      input.shift &&
      !input.control &&
      !input.alt &&
      !input.isAutoRepeat &&
      input.key.toLowerCase() === "w"
    ) {
      event.preventDefault();
      const entry = windows.get(owner);
      if (entry)
        setWindowMode(
          entry,
          entry.mode === "tracker" ? "workbench" : "tracker",
        );
    }
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) await window.loadURL(devServer);
  else
    await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return window;
}

app.setAboutPanelOptions({ applicationName: "Loom" });

app.whenReady().then(async () => {
  // Electron's default File menu binds Cmd+W to Close Window, which quits a one-window app and
  // steals the Workbench's own Cmd+W. Close Window stays in the menu, without an accelerator.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: "Loom",
              submenu: [
                { role: "about" as const, label: "About Loom" },
                ...(controls.available()
                  ? [
                      { type: "separator" as const },
                      {
                        label: "Update and Restart",
                        click: () => void updateAndRestart(),
                      },
                      {
                        label: "Restart Loom",
                        click: () =>
                          void controls
                            .run("restart-app")
                            .catch((error) =>
                              dialog.showErrorBox(
                                "Loom couldn't restart",
                                String(error),
                              ),
                            ),
                      },
                    ]
                  : []),
                { type: "separator" as const },
                { role: "services" as const },
                { type: "separator" as const },
                { role: "hide" as const, label: "Hide Loom" },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const, label: "Quit Loom" },
              ],
            },
          ]
        : []),
      { role: "editMenu" },
      { role: "viewMenu" },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          { role: "front" },
          { type: "separator" },
          {
            label: "Close Window",
            click: () => BrowserWindow.getFocusedWindow()?.close(),
          },
        ],
      },
    ]),
  );
  wire();
  await createWindow(
    process.env.LOOM_WINDOW_MODE === "workbench"
      ? "workbench"
      : (startupSettings?.windowMode ?? "tracker"),
  );
});

// Quitting detaches every terminal. Nothing else of ours outlives the window.
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
  keybindings.close();
  for (const owner of windows.keys()) sessions.close(owner);
});

app.on("window-all-closed", () => app.quit());
// `dev.sh` stops the app with SIGTERM. Quit properly, so terminals detach and no dialog can
// hold the old window open while the new one is starting.
process.on("SIGTERM", () => app.quit());
