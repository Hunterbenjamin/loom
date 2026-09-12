// The invalidation channel: one control-mode client, subscribed to formats.
//
// Two tmux facts shape this. `refresh-client -B`'s `%*` covers only the panes of the session
// the control client is attached to, so per-pane subscriptions cannot watch the whole server;
// and `%exit` means *this client* is leaving, never that a pane exited (spike 06 §4). So the
// server-wide signal is a global user option that the `pane-died`/`pane-exited` hooks bump,
// plus tmux's own window notifications. Everything here is a hint: re-read, never act.

import { type ChildProcess, spawn } from "node:child_process";
import { EVENT_OPTION, MONITOR_SESSION } from "./config.js";

/** Notifications that mean the pane table may have changed. */
const INVALIDATING = [
  "%subscription-changed",
  "%window-add",
  "%window-close",
  "%unlinked-window-add",
  "%unlinked-window-close",
  "%sessions-changed",
  "%layout-change",
];

export interface MonitorOptions {
  executable: string;
  socketName: string;
  env: Record<string, string>;
  reconnectMs: number;
  onInvalidated: () => void;
  onError?: (error: Error) => void;
}

/** Splits control-mode output into lines and reports the ones that matter. */
export function classifyLine(line: string): "invalidate" | "exit" | "ignore" {
  if (line.startsWith("%exit")) return "exit";
  const name = line.split(" ", 1)[0] ?? "";
  return INVALIDATING.includes(name) ? "invalidate" : "ignore";
}

export function startMonitor(options: MonitorOptions): () => void {
  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const reconnect = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, options.reconnectMs);
    timer.unref?.();
  };

  function connect(): void {
    if (stopped) return;
    const proc = spawn(
      options.executable,
      [
        "-L",
        options.socketName,
        "-C",
        "attach-session",
        "-t",
        MONITOR_SESSION,
        "-f",
        "no-output,ignore-size",
      ],
      { env: options.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    child = proc;
    proc.stdout?.setEncoding("utf8");
    // `-B name::format` with an empty `what` evaluates the format for the attached session,
    // which is where a global user option can be read from.
    proc.stdin?.write(
      `refresh-client -B 'loom-event::#{${EVENT_OPTION}}'\n`,
      () => undefined,
    );
    let buffer = "";
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const kind = classifyLine(line);
        if (kind === "invalidate") options.onInvalidated();
        else if (kind === "exit" && child === proc) reconnect();
      }
    });
    proc.on("error", (error) => {
      options.onError?.(error);
      if (child === proc) reconnect();
    });
    proc.on("exit", () => {
      if (child === proc) reconnect();
    });
  }

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    const proc = child;
    child = null;
    proc?.kill("SIGTERM");
  };
}
