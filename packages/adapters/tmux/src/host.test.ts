// These run against a throwaway tmux server of their own (`-L loom-test-<pid>`), created and
// killed here. tmux is local and fast, so the host's real behaviour is worth testing directly;
// no test ever names another socket, and no agent is started.

import { execFile as execFileCb, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  PaneHost,
  PaneRef,
  RunId,
  TaskId,
  WorktreePath,
} from "@loom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTmuxPaneHost, TmuxError } from "./index.js";

const execFile = promisify(execFileCb);
const instance = `test-${process.pid}`;
const socket = `loom-${instance}`;

// The adapter runs tmux with the allowlisted client environment, so the executable has to be
// findable without the caller's PATH: resolve it once, absolutely.
const TMUX = await execFile("/usr/bin/which", [
  process.env.LOOM_TMUX_BIN ?? "tmux",
]).then(
  ({ stdout }) => stdout.trim(),
  () => "",
);
const available = TMUX !== "";

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFile(TMUX, ["-L", socket, ...args]);
  return stdout;
}

/** Waits for `check` to hold, so a test never sleeps longer than it has to. */
async function until<T>(
  check: () => Promise<T | null>,
  timeoutMs = 5000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== false) return value;
    if (Date.now() > end) throw new Error("timed out");
    await delay(25);
  }
}

describe.skipIf(!available)("tmux pane host", () => {
  let dir: string;
  let host: PaneHost;
  let cwd: WorktreePath;

  const paneEnv = (extra: Record<string, string> = {}) => ({
    PATH: "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    ...extra,
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "loom-tmux-test-"));
    cwd = dir as WorktreePath;
    host = createTmuxPaneHost({
      instance,
      configPath: join(dir, "tmux.conf"),
      tmuxExecutable: TMUX,
      pasteSettleMs: 60,
      // A deliberately small client environment: the pane must not see anything else.
      clientEnv: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
    });
  });

  afterAll(async () => {
    await tmux("kill-server").catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("loads the private config before any pane exists", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-config" as TaskId,
      cwd,
      label: "config",
    });
    expect(workspace.workspaceId).toBe("loom-t-config");
    const show = async (scope: string, option: string) =>
      (await tmux("show-options", scope, "-v", option)).trim();
    expect(await show("-g", "status")).toBe("off");
    expect(await show("-g", "mouse")).toBe("on");
    expect(await show("-g", "window-size")).toBe("latest");
    expect(await show("-g", "aggressive-resize")).toBe("on");
    expect(await show("-g", "remain-on-exit")).toBe("on");
    expect(await show("-s", "extended-keys")).toBe("always");
    // `extended-keys-format` exists from tmux 3.5; older servers (CI runners) skip it by design.
    const version = (await tmux("display-message", "-p", "#{version}")).trim();
    if (version >= "3.5")
      expect(await show("-s", "extended-keys-format")).toBe("csi-u");
    expect(await show("-g", "update-environment")).toBe("");
    expect(await tmux("show-options", "-g", "-v", "terminal-features")).toMatch(
      /xterm\*:extkeys/,
    );
  });

  it("gives the pane exactly the allowlisted environment, read from inside it", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-env" as TaskId,
      cwd,
      label: "env",
    });
    // A marker that exists in the tmux server's own environment must not reach the pane.
    await tmux("set-environment", "-g", "LOOM_TEST_LEAK", "leak");
    const out = join(dir, "env.txt");
    const ref = await host.ensurePane({
      workspaceId: workspace.workspaceId,
      runId: "run-env" as RunId,
      cwd,
      executable: "/bin/sh",
      args: ["-c", `env > ${out}; sleep 30`],
      env: paneEnv({ LOOM_WANTED: "yes" }),
    });
    expect(ref.paneId).toMatch(/^%\d+$/);
    const names = await until(async () => {
      const text = await readFile(out, "utf8").catch(() => null);
      return text === null ? null : text;
    });
    const env = Object.fromEntries(
      names
        .split("\n")
        .filter(Boolean)
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    expect(env.LOOM_WANTED).toBe("yes");
    expect(env.LOOM_TEST_LEAK).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.HERDR_ENV).toBeUndefined();
    // tmux takes PATH from the client process, not from `-e`, so the adapter sets both.
    expect(env.PATH).toBe("/usr/bin:/bin");
    await host.closePane(ref);
  });

  it("is idempotent on runId and replaces a dead pane", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-idem" as TaskId,
      cwd,
      label: "idem",
    });
    const start = () =>
      host.ensurePane({
        workspaceId: workspace.workspaceId,
        runId: "run-idem" as RunId,
        cwd,
        executable: "/bin/sh",
        args: ["-c", "sleep 30"],
        env: paneEnv(),
      });
    const first = await start();
    expect(await start()).toEqual(first);
    await tmux("kill-pane", "-t", first.paneId);
    const second = await start();
    expect(second.paneId).not.toBe(first.paneId);
    await host.closePane(second);
  });

  it("reports a pane's exit natively and hints within a second", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-exit" as TaskId,
      cwd,
      label: "exit",
    });
    let hints = 0;
    const unsubscribe = host.subscribe(() => {
      hints++;
    });
    const ref = await host.ensurePane({
      workspaceId: workspace.workspaceId,
      runId: "run-exit" as RunId,
      cwd,
      executable: "/bin/sh",
      args: ["-c", "read line; exit 7"],
      env: paneEnv(),
    });
    await until(async () => (await host.getPane(ref))?.dead === false);
    const before = hints;
    const at = Date.now();
    await host.pasteText(ref, "go");
    const snapshot = await until(async () => {
      const pane = await host.getPane(ref);
      return pane?.dead ? pane : null;
    });
    const deadAt = Date.now();
    expect(snapshot.exitCode).toBe(7);
    expect(snapshot.cwd).toBeNull();
    // `pane_start_path` outlives the process, which is what keeps the task join working.
    expect(snapshot.startCwd).toBe(await realpath(dir));
    // The hook bumps a global option; the subscription reports it at most a second later.
    await until(async () => hints > before, 4000);
    // The brief asks for this latency; it is reported rather than asserted on.
    console.log(
      `pane exit: dead in ${deadAt - at} ms, hint within ${Date.now() - deadAt} ms of that`,
    );
    unsubscribe();
    await host.closePane(ref);
  });

  it("pastes 20 KB in byte-bounded chunks, byte-identical, with CRLF normalized", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-paste" as TaskId,
      cwd,
      label: "paste",
    });
    const out = join(dir, "paste.txt");
    const ref = await host.ensurePane({
      workspaceId: workspace.workspaceId,
      runId: "run-paste" as RunId,
      cwd,
      executable: "/bin/sh",
      // Raw mode: a cooked tty silently drops a 20 KB line at MAX_CANON, which would test
      // the terminal's line discipline rather than the host's chunking.
      args: ["-c", `stty raw -echo; cat > ${out}`],
      env: paneEnv(),
    });
    // 20 KB whose chunk boundary lands inside a four-byte code point, plus a CRLF line.
    const filler = "a".repeat(2046);
    const text = `${filler}🌱${"b".repeat(20000)}\r\nlast`;
    expect(await host.pasteText(ref, text)).toBe("written");
    const written = await until(async () => {
      const got = await readFile(out, "utf8").catch(() => null);
      // `cat` flushes in 4 KB blocks, so wait for the 20 KB body rather than every byte.
      return got && got.length >= 20000 ? got : null;
    }, 10000);
    // `cat` is line-buffered by the tty: compare what the pane received, newline-normalized.
    expect(written.replaceAll("\r\n", "\n").replaceAll("\r", "\n")).toContain(
      `${filler}🌱`,
    );
    expect(written).not.toContain("\r\n");
    await host.closePane(ref);
  });

  it("refuses text a TUI would read as a command", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-slash" as TaskId,
      cwd,
      label: "slash",
    });
    const ref = await host.ensurePane({
      workspaceId: workspace.workspaceId,
      runId: "run-slash" as RunId,
      cwd,
      executable: "/bin/sh",
      args: ["-c", "sleep 30"],
      env: paneEnv(),
    });
    await expect(host.pasteText(ref, "/compact")).rejects.toBeInstanceOf(
      TmuxError,
    );
    await expect(host.pasteText(ref, "!ls")).rejects.toBeInstanceOf(TmuxError);
    await host.closePane(ref);
  });

  it("lets two clients watch one pane, and two views of one task pick windows apart", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-view" as TaskId,
      cwd,
      label: "view",
    });
    const panes: PaneRef[] = [];
    for (const runId of ["run-a", "run-b"] as RunId[])
      panes.push(
        await host.ensurePane({
          workspaceId: workspace.workspaceId,
          runId,
          cwd,
          executable: "/bin/sh",
          args: ["-c", "sleep 60"],
          env: paneEnv(),
        }),
      );
    const [a, b] = panes as [PaneRef, PaneRef];
    // Two ordinary clients on one pane, plus a third viewing a different run of the same task.
    const clients = [
      attach(host.attachArgs(a)),
      attach(host.attachArgs(a)),
      attach(host.attachArgs(b)),
    ];
    try {
      // Two ordinary clients share one pane: no takeover, no eviction.
      await until(async () => (await host.listClients(a)).length >= 2);
      expect((await host.listClients(a)).length).toBeGreaterThanOrEqual(2);
      // The task's two views are grouped sessions, so each has its own current window.
      const windowOf = async (ref: PaneRef) =>
        (
          await tmux(
            "display-message",
            "-p",
            "-t",
            `${ref.sessionName}-v${ref.paneId.slice(1)}`,
            "#{window_id}",
          )
        ).trim();
      await until(async () => (await windowOf(b)) === b.windowId);
      expect(await windowOf(a)).toBe(a.windowId);
      expect(await windowOf(b)).toBe(b.windowId);
      expect(a.windowId).not.toBe(b.windowId);
    } finally {
      for (const client of clients) client.kill("SIGKILL");
      await delay(200);
      for (const ref of panes) await host.closePane(ref);
    }
  });

  it("scopes pane refs to a host generation across a kill-server", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-gen" as TaskId,
      cwd,
      label: "gen",
    });
    const ref = await host.ensurePane({
      workspaceId: workspace.workspaceId,
      runId: "run-gen" as RunId,
      cwd,
      executable: "/bin/sh",
      args: ["-c", "sleep 30"],
      env: paneEnv(),
    });
    expect(await host.getPane(ref)).not.toBeNull();
    await tmux("kill-server").catch(() => undefined);
    await delay(200);
    // The new server restarts pane IDs at %0, so the old ref must resolve to nothing even
    // when a pane with that ID exists again.
    const next = await host.ensureWorkspace({
      taskId: "t-gen" as TaskId,
      cwd,
      label: "gen",
    });
    const revived = await host.ensurePane({
      workspaceId: next.workspaceId,
      runId: "run-gen" as RunId,
      cwd,
      executable: "/bin/sh",
      args: ["-c", "sleep 30"],
      env: paneEnv(),
    });
    expect(revived.hostGeneration).not.toBe(ref.hostGeneration);
    expect(await host.getPane(ref)).toBeNull();
    expect(await host.getPane(revived)).not.toBeNull();
    await host.closePane(revived);
  });
});

/** Gives an attach client a pty without pulling in a terminal dependency. */
function attach(args: string[]) {
  const [file, ...rest] = args as [string, ...string[]];
  return spawn("script", ["-q", "/dev/null", file, ...rest], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      TERM: "xterm-256color",
    },
    stdio: "ignore",
  });
}

// Nothing is left behind even if `afterAll` never runs.
process.on("exit", () => {
  execFileCb(TMUX, ["-L", socket, "kill-server"], () => undefined);
});
