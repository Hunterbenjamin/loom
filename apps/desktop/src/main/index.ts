// The Electron main process. It owns the window and the PTYs behind the Terminal tab, and
// no durable task state: the coordinator remains the owner.
import { createRequire } from "node:module";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Notification } from "electron";
import { z } from "zod";
import { connectionFromEnvironment } from "../shared/connection.js";
import {
  type PtyExit,
  type PtySpawnResult,
  ptySpawnRequest,
  type WindowMode,
  windowMode,
} from "../shared/ipc.js";
import { resolveAttach } from "./attach.js";
import { OwnedResources } from "./ownership.js";

const connection = connectionFromEnvironment(
  process.env,
  process.argv.includes("--fixtures"),
);

// node-pty is a native CommonJS addon; electron-vite externalizes it, so require it directly.
const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

// A window Chromium thinks is covered stops requestAnimationFrame, which stalls both the
// terminal and the Playwright harness (spike 03).
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

interface Session {
  proc: import("node-pty").IPty;
  chunks: string[];
  timer: NodeJS.Timeout | null;
  lastFlush: number;
}

<<<<<<< HEAD
const sessions = new Map<string, Session>();
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
=======
const sessions = new OwnedResources<Session>((session) => {
  if (session.timer) clearTimeout(session.timer);
  session.proc.kill("SIGHUP");
});
const windows = new Map<
  number,
  { window: BrowserWindow; mode: WindowMode; spare: boolean }
>();
let spare: Promise<BrowserWindow> | null = null;
let quitting = false;
function prepareWorkbench() {
  if (spare || quitting || connection.mode !== "live") return;
  spare = createWindow("workbench", true).catch((error) => {
    spare = null;
    throw error;
  });
  void spare.catch(() => undefined);
}
async function openWindow(mode: WindowMode) {
  if (mode === "workbench" && spare) {
    const prepared = spare;
    spare = null;
    const window = await prepared;
    const entry = window.isDestroyed()
      ? undefined
      : windows.get(window.webContents.id);
    if (entry && !window.isDestroyed()) {
      entry.spare = false;
      window.show();
      window.focus();
    } else await createWindow(mode);
  } else await createWindow(mode);
  setTimeout(prepareWorkbench, 1000).unref();
}
function owned(sender: Electron.WebContents) {
  const entry = windows.get(sender.id);
  if (!entry || entry.window.isDestroyed() || sender.isDestroyed())
    throw new Error("Unknown window");
  return entry;
}
>>>>>>> origin/main

/**
 * A plain login shell by default. `LOOM_ATTACH_PANE=<session>:<window-id>` attaches to a pane on
 * the pane host instead, which is how the performance harness measures a real agent. Loom never
 * starts or controls the agent itself; attach is a viewer, and other clients keep their own view.
 */
function command(): { file: string; args: string[] } {
  const target = process.env.LOOM_ATTACH_PANE;
  if (target) {
    const [session = "", windowId = ""] = target.split(":");
    const view = `${session}-v${windowId.replace("@", "")}`;
    return {
      file: process.env.LOOM_TMUX_BIN ?? "tmux",
      args: [
        "-L",
        `loom-${process.env.LOOM_INSTANCE ?? "dev"}`,
        "new-session",
        "-A",
        "-d",
        "-s",
        view,
        "-t",
        session,
        ";",
        "select-window",
        "-t",
        `${view}:${windowId}`,
        ";",
        "attach-session",
        "-t",
        view,
      ],
    };
  }
  return { file: process.env.SHELL ?? "/bin/zsh", args: ["-l"] };
}

function flush(window: BrowserWindow, id: string): void {
  const session = sessions.get(window.webContents.id, id);
  if (!session || session.chunks.length === 0) return;
  const data = session.chunks.join("");
  session.chunks = [];
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  session.lastFlush = Date.now();
  if (!window.isDestroyed()) window.webContents.send("pty:data", id, data);
}

function wire(): void {
  ipcMain.handle("app:connection", (event) => {
    owned(event.sender);
    return connection;
  });
  ipcMain.handle("app:mode", (event) => owned(event.sender).mode);
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
      const target =
        connection.mode === "fixtures"
          ? null
          : request.pane
            ? await resolveAttach(connection, request.pane)
            : request.lead
              ? await resolveAttach(connection, "lead")
              : request.runId
                ? await resolveAttach(connection, request.runId)
                : null;
      if (connection.mode !== "fixtures" && !target?.attach)
        throw new Error("Select a run with a live terminal pane");
      if (window.isDestroyed()) throw new Error("Window closed");
      owned(event.sender);
      const resolved = target?.attach;
      const { file, args } = resolved
        ? { file: resolved.argv[0] as string, args: resolved.argv.slice(1) }
        : command();
      const proc = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: request.cols,
        rows: request.rows,
        cwd: resolved?.cwd ?? process.env.HOME,
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
      const session: Session = { proc, chunks: [], timer: null, lastFlush: 0 };
      if (!sessions.finish(event.sender.id, request.id, token, session))
        throw new Error("Panel closed");
      // Coalesce for a frame, so a flood is a handful of IPC messages instead of thousands.
      proc.onData((data) => {
        if (sessions.get(event.sender.id, request.id) !== session) return;
        session.chunks.push(data);
        if (Date.now() - session.lastFlush > 8) flush(window, request.id);
        else if (!session.timer)
          session.timer = setTimeout(() => flush(window, request.id), 4);
      });
      proc.onExit(({ exitCode, signal }) => {
        if (sessions.get(event.sender.id, request.id) !== session) return;
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
  ipcMain.handle("pty:kill", (event, id: string) => {
    owned(event.sender);
    return sessions.kill(event.sender.id, id);
  });

  // The cold-start measurement spawns this app directly and reads this line, so the number
  // is the app's own start-up and not Playwright's debugger attaching.
  let reported = false;
  ipcMain.on("app:interactive", (event) => {
    const entry = windows.get(event.sender.id);
    if (!entry?.spare) setTimeout(prepareWorkbench, 1000).unref();
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

async function createWindow(
  mode: WindowMode,
  isSpare = false,
): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    show: !isSpare,
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
  const owner = window.webContents.id;
  windows.set(owner, { window, mode, spare: isSpare });
  sessions.open(owner);
  const cleanup = () => {
    sessions.close(owner);
    windows.delete(owner);
    if (!quitting && ![...windows.values()].some((entry) => !entry.spare))
      app.quit();
  };
  window.on("closed", cleanup);
  window.webContents.on("render-process-gone", cleanup);
  window.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      input.meta &&
      input.shift &&
      input.key.toLowerCase() === "w"
    ) {
      event.preventDefault();
      void openWindow("workbench");
    }
  });

  // The performance harness asks for a longer list; nothing else sets this.
  const search = process.env.LOOM_TASKS
    ? `tasks=${process.env.LOOM_TASKS}`
    : "";
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer)
    await window.loadURL(search ? `${devServer}?${search}` : devServer);
  else
    await window.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
      search,
    });
  return window;
}

app.whenReady().then(async () => {
  wire();
  await createWindow(
    process.env.LOOM_WINDOW_MODE === "workbench" ? "workbench" : "tracker",
  );
});

// Quitting detaches every terminal. Nothing else of ours outlives the window.
app.on("before-quit", () => {
  quitting = true;
  for (const owner of windows.keys()) sessions.close(owner);
});

app.on("window-all-closed", () => app.quit());
