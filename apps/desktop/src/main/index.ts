// The Electron main process. It owns the window and the PTYs behind the Terminal tab, and
// nothing else: this shell has no coordinator, no adapters and no disk state.
import { createRequire } from "node:module";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type {
  PtyExit,
  PtySpawnRequest,
  PtySpawnResult,
} from "../shared/ipc.js";

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
}

const sessions = new Map<string, Session>();

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
  const session = sessions.get(id);
  if (!session || session.chunks.length === 0) return;
  const data = session.chunks.join("");
  session.chunks = [];
  session.timer = null;
  if (!window.isDestroyed()) window.webContents.send("pty:data", id, data);
}

function wire(window: BrowserWindow): void {
  ipcMain.handle(
    "pty:spawn",
    (_event, request: PtySpawnRequest): PtySpawnResult => {
      sessions.get(request.id)?.proc.kill("SIGHUP");
      const { file, args } = command();
      const proc = pty.spawn(file, args, {
        name: "xterm-256color",
        cols: request.cols,
        rows: request.rows,
        cwd: process.env.HOME,
        env: {
          ...(process.env as Record<string, string>),
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      });
      const session: Session = { proc, chunks: [], timer: null };
      sessions.set(request.id, session);
      // Coalesce for a frame, so a flood is a handful of IPC messages instead of thousands.
      proc.onData((data) => {
        session.chunks.push(data);
        if (!session.timer)
          session.timer = setTimeout(() => flush(window, request.id), 4);
      });
      proc.onExit(({ exitCode, signal }) => {
        flush(window, request.id);
        sessions.delete(request.id);
        const info: PtyExit = { exitCode, signal: signal ?? 0 };
        if (!window.isDestroyed())
          window.webContents.send("pty:exit", request.id, info);
      });
      return { pid: proc.pid, command: [file, ...args].join(" ") };
    },
  );

  ipcMain.on("pty:write", (_event, id: string, data: string) => {
    sessions.get(id)?.proc.write(data);
  });

  ipcMain.on("pty:resize", (_event, id: string, cols: number, rows: number) => {
    try {
      sessions.get(id)?.proc.resize(cols, rows);
    } catch {
      // The process can exit between the resize event and this call.
    }
  });

  // Closing a panel detaches, exactly like closing a terminal window: SIGHUP, and the agent
  // behind an attach keeps running (spike 03).
  ipcMain.handle("pty:kill", (_event, id: string) => {
    const session = sessions.get(id);
    if (!session) return false;
    session.proc.kill("SIGHUP");
    return true;
  });

  // The cold-start measurement spawns this app directly and reads this line, so the number
  // is the app's own start-up and not Playwright's debugger attaching.
  let reported = false;
  ipcMain.on("app:interactive", () => {
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

app.whenReady().then(async () => {
  const window = new BrowserWindow({
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
  wire(window);

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
});

// Quitting detaches every terminal. Nothing else of ours outlives the window.
app.on("before-quit", () => {
  for (const session of sessions.values()) session.proc.kill("SIGHUP");
});

app.on("window-all-closed", () => app.quit());
