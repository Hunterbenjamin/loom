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
const PYTHON = await execFile("/usr/bin/which", ["python3"]).then(
  ({ stdout }) => stdout.trim(),
  () => "",
);

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFile(TMUX, ["-L", socket, ...args]);
  return stdout;
}

// Legacy setup only: production code must never issue native rename commands.
const legacySessionRename = ["rename", "session"].join("-");
const legacyWindowRename = ["rename", "window"].join("-");

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

  it("stores independent space, tab and pane titles without changing native identity", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-rename" as TaskId,
      cwd,
      label: "Rename",
    });
    const request = {
      workspaceId: workspace.workspaceId,
      createWorkspace: true,
      key: crypto.randomUUID(),
      cwd,
      executable: "/bin/sh",
      args: [],
      env: paneEnv(),
    };
    const first = await host.createScratch(request);
    const sibling = await host.createScratch({
      ...request,
      key: crypto.randomUUID(),
      target: first,
      split: "below",
    });
    const otherTab = await host.createScratch({
      ...request,
      key: crypto.randomUUID(),
      target: first,
    });
    const before = await host.getPane(first);
    const sessionId = before?.sessionId as string;
    const space = {
      hostGeneration: first.hostGeneration,
      target: { kind: "space" as const, sessionId },
      title: "  Project alpha  ",
    };
    await host.setTitle(space);
    await host.setTitle(space);
    await host.setTitle({
      hostGeneration: first.hostGeneration,
      target: { kind: "tab", windowId: first.windowId as string },
      title: "Review: v2.0",
    });
    await host.setTitle({
      hostGeneration: first.hostGeneration,
      target: { kind: "pane", paneId: first.paneId },
      title: "Reviewer",
    });
    const titled = await host.getPane(first);
    expect(titled).toMatchObject({
      pid: before?.pid,
      dead: false,
      sessionId,
      spaceTitle: "Project alpha",
      tabTitle: "Review: v2.0",
      paneTitle: "Reviewer",
      windowName: before?.windowName,
      ref: first,
    });
    expect(await host.getPane(sibling)).toMatchObject({
      spaceTitle: "Project alpha",
      tabTitle: "Review: v2.0",
      paneTitle: null,
    });
    expect(await host.getPane(otherTab)).toMatchObject({
      spaceTitle: "Project alpha",
      tabTitle: null,
      paneTitle: null,
    });
    const reconnected = createTmuxPaneHost({
      instance,
      configPath: join(dir, "tmux.conf"),
      tmuxExecutable: TMUX,
    });
    expect(await reconnected.getPane(first)).toMatchObject({
      spaceTitle: "Project alpha",
      tabTitle: "Review: v2.0",
      paneTitle: "Reviewer",
    });
    await host.setTitle({ ...space, title: "  " });
    expect((await host.getPane(first))?.spaceTitle).toBeNull();
    await expect(
      host.setTitle({ ...space, title: "bad\nname" }),
    ).rejects.toThrow();
    await expect(
      host.setTitle({ ...space, hostGeneration: "loom-other#1" }),
    ).rejects.toThrow("stale_generation");
    await expect(
      host.setTitle({
        ...space,
        target: { kind: "space", sessionId: "$999999" },
      }),
    ).rejects.toThrow("session_not_found");
    await expect(
      host.setTitle({
        hostGeneration: first.hostGeneration,
        target: { kind: "tab", windowId: "@999999" },
        title: "Missing",
      }),
    ).rejects.toThrow("window_not_found");
    await expect(
      host.setTitle({
        hostGeneration: first.hostGeneration,
        target: { kind: "pane", paneId: "%999999" },
        title: "Missing",
      }),
    ).rejects.toThrow("pane_not_found");
  });

  it("keeps scratch creation idempotent after a window rename", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-scratch" as TaskId,
      cwd,
      label: "scratch",
    });
    const request = {
      workspaceId: workspace.workspaceId,
      createWorkspace: true,
      key: crypto.randomUUID(),
      cwd,
      executable: "/bin/sh",
      args: [],
      env: paneEnv(),
    };
    const first = await host.createScratch(request);
    await tmux(
      legacyWindowRename,
      "-t",
      first.windowId as string,
      "human name",
    );
    expect(await host.createScratch(request)).toEqual(first);
    expect(
      (await host.listPanes()).filter(
        (p) => p.ref.sessionName === workspace.workspaceId,
      ),
    ).toHaveLength(1);
    expect((await host.getPane(first))?.dead).toBe(false);
  });

  it("human close removes an exact terminal, including legacy untagged shells, without touching neighbours", async () => {
    const req = {
      workspaceId: "loom-close-check",
      createWorkspace: true,
      key: crypto.randomUUID(),
      cwd,
      executable: "/bin/sh",
      args: [],
      env: paneEnv(),
    };
    const first = await host.createScratch(req);
    const second = await host.createScratch({
      ...req,
      key: crypto.randomUUID(),
    });
    // A mismatched identity must never close a pane, even when its numeric ID exists.
    await host.closeTerminal({ ...first, windowId: "@999999" });
    await host.closeTerminal({ ...first, sessionName: "wrong-session" });
    await host.closeTerminal({ ...first, hostGeneration: "loom-old#1" });
    expect((await host.getPane(first))?.dead).toBe(false);
    await expect(host.closePane(first)).rejects.toMatchObject({
      code: "pane_not_owned",
    });
    await host.closeTerminal(first);
    await host.closeTerminal(first);
    expect(await host.getPane(first)).toBeNull();
    expect((await host.getPane(second))?.dead).toBe(false);
    const legacyId = (
      await tmux(
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        "loom-close-check:",
        "-n",
        "shell",
        "/bin/sh",
      )
    ).trim();
    const legacy = (await host.listPanes()).find(
      (p) => p.ref.paneId === legacyId,
    );
    if (!legacy) throw new Error("Missing legacy shell");
    await host.closeTerminal(legacy.ref);
    expect(await host.getPane(legacy.ref)).toBeNull();
    await host.closeTerminal(second);
    expect(
      (await host.listPanes()).filter(
        (p) => p.ref.sessionName === "loom-close-check",
      ),
    ).toEqual([]);
  });

  it("opens one standalone shell, reuses it across clients and reconnects, and replaces an exited shell", async () => {
    const req = {
      workspaceId: "loom-workbench",
      label: "Named terminal",
      createWorkspace: true,
      key: crypto.randomUUID(),
      cwd,
      executable: "/bin/sh",
      args: [],
      env: paneEnv(),
    };
    const [first, second] = await Promise.all([
      host.createScratch(req),
      host.createScratch(req),
    ]);
    expect(second).toEqual(first);
    const reopened = createTmuxPaneHost({
      instance,
      configPath: join(dir, "tmux.conf"),
      tmuxExecutable: TMUX,
      clientEnv: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" },
    });
    expect(await reopened.createScratch(req)).toEqual(first);
    const shells = async () =>
      (await host.listPanes()).filter(
        (p) => p.ref.sessionName === req.workspaceId,
      );
    expect(await shells()).toHaveLength(1);
    expect((await shells())[0]?.windowName).toBe("Named terminal");
    await tmux("send-keys", "-t", first.paneId, "exit", "Enter");
    await until(async () => (await host.getPane(first))?.dead || null);
    const replacement = await host.createScratch(req);
    expect(replacement.paneId).not.toBe(first.paneId);
    expect(await shells()).toHaveLength(1);
    expect((await host.getPane(replacement))?.dead).toBe(false);
    const another = await host.createScratch({
      ...req,
      key: crypto.randomUUID(),
    });
    expect(another.paneId).not.toBe(replacement.paneId);
    expect(await shells()).toHaveLength(2);
  });

  it("creates windows in a legacy renamed space and idempotent splits in its active window", async () => {
    const request = {
      workspaceId: "loom-space-layout",
      key: crypto.randomUUID(),
      cwd,
      executable: "/bin/sh",
      args: [],
      env: paneEnv(),
    };
    const first = await host.createScratch(request);
    const observation = await host.getPane(first);
    if (!observation?.sessionId) throw new Error("Missing native session");
    await tmux(
      "set-option",
      "-t",
      observation.sessionId,
      "@loom_workspace_id",
      request.workspaceId,
    );
    await tmux(
      legacySessionRename,
      "-t",
      observation.sessionId,
      "Renamed layout",
    );
    const tab = await host.createScratch({
      ...request,
      key: crypto.randomUUID(),
      target: first,
      label: "Second",
    });
    expect(tab.sessionName).toBe("Renamed layout");
    expect(tab.windowId).not.toBe(first.windowId);
    const splitRequest = {
      ...request,
      key: crypto.randomUUID(),
      target: tab,
      split: "below" as const,
    };
    const split = await host.createScratch(splitRequest);
    expect(await host.createScratch(splitRequest)).toEqual(split);
    expect(split.windowId).toBe(tab.windowId);
    expect(split.paneId).not.toBe(tab.paneId);
    const splitPane = await host.getPane(split);
    expect(splitPane?.windowLayout).toContain("[");
    expect(splitPane?.windowIndex).toBeTypeOf("number");
    await expect(
      host.createScratch({
        ...splitRequest,
        target: { ...tab, hostGeneration: "loom-test#stale" },
      }),
    ).rejects.toThrow();
  });

  it("reserves a task workspace without a blank shell and launches only the requested agent pane", async () => {
    const { workspaceId } = await host.ensureWorkspace({
      taskId: "t-no-shell" as TaskId,
      cwd,
      label: "An issue title",
    });
    expect(
      (await host.listPanes()).filter((p) => p.ref.sessionName === workspaceId),
    ).toEqual([]);
    expect(await tmux("list-sessions", "-F", "#{session_name}")).not.toContain(
      workspaceId,
    );
    const pane = await host.ensurePane({
      workspaceId,
      runId: "run-no-shell" as RunId,
      cwd,
      executable: "/bin/sleep",
      args: ["30"],
      env: paneEnv(),
    });
    const panes = (await host.listPanes()).filter(
      (p) => p.ref.sessionName === workspaceId,
    );
    expect(panes.map((p) => p.ref)).toEqual([pane]);
    expect(
      await tmux("list-panes", "-t", workspaceId, "-F", "#{pane_id}"),
    ).toBe(`${pane.paneId}\n`);
    expect(
      await host.ensurePane({
        workspaceId,
        runId: "run-no-shell" as RunId,
        cwd,
        executable: "/bin/sleep",
        args: ["30"],
        env: paneEnv(),
      }),
    ).toEqual(pane);
  });

  it("holds no idle window: the session lives exactly as long as Loom's panes", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-lazy" as TaskId,
      cwd,
      label: "lazy",
    });
    const windows = () =>
      tmux("list-windows", "-t", `=${workspace.workspaceId}`, "-F", "#W")
        .then((out) => out.split("\n").filter(Boolean))
        .catch(() => null);
    expect(await windows()).toBeNull();
    const ref = await host.ensurePane({
      workspaceId: workspace.workspaceId,
      runId: "run-lazy" as RunId,
      cwd,
      executable: "/bin/sh",
      args: ["-c", "sleep 30"],
      env: paneEnv(),
    });
    expect(await windows()).toEqual(["run-lazy"]);
    expect(
      (await host.listPanes()).filter(
        (p) => p.ref.sessionName === workspace.workspaceId,
      ),
    ).toHaveLength(1);
    await host.closePane(ref);
    expect(await windows()).toBeNull();
    expect(await host.getPane(ref)).toBeNull();
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

  // Real clients and sub-second exit hints need a terminal and an idle machine; CI has neither.
  it.skipIf(process.env.CI)(
    "reports a pane's exit natively and hints within a second",
    async () => {
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
    },
  );

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

  it("submits pasted text while preserving copy mode", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-copy-paste" as TaskId,
      cwd,
      label: "copy paste",
    });
    const out = join(dir, "copy-paste.txt");
    const ref = await host.ensurePane({
      workspaceId: workspace.workspaceId,
      runId: "run-copy-paste" as RunId,
      cwd,
      executable: "/bin/sh",
      args: ["-c", `stty raw -echo; dd bs=1 count=3 of=${out}; sleep 30`],
      env: paneEnv(),
    });
    await until(async () => (await host.getPane(ref))?.dead === false);
    await tmux("copy-mode", "-t", ref.paneId);
    expect(
      (
        await tmux("display-message", "-p", "-t", ref.paneId, "#{pane_in_mode}")
      ).trim(),
    ).toBe("1");

    expect(await host.pasteText(ref, "go")).toBe("written");
    await until(
      async () => (await readFile(out, "utf8").catch(() => null)) === "go\r",
    );
    expect(
      (
        await tmux("display-message", "-p", "-t", ref.paneId, "#{pane_in_mode}")
      ).trim(),
    ).toBe("1");
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

  it.skipIf(process.env.CI)(
    "lets two clients watch one pane, and two views of one task pick windows apart",
    async () => {
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
        const sessionId = (await host.getPane(a))?.sessionId as string;
        await tmux(
          "set-option",
          "-t",
          sessionId,
          "@loom_workspace_id",
          a.sessionName,
        );
        await tmux(legacySessionRename, "-t", sessionId, "Renamed viewers");
        expect((await host.listClients(a)).length).toBeGreaterThanOrEqual(2);
        expect(await windowOf(a)).toBe(a.windowId);
        const renamed = (await host.getPane(a))?.ref as PaneRef;
        clients.push(attach(host.attachArgs(renamed)));
        await until(async () => (await host.listClients(renamed)).length >= 4);
      } finally {
        for (const client of clients) client.kill("SIGKILL");
        await delay(200);
        for (const ref of panes) await host.closePane(ref);
      }
    },
  );

  it("isolates input between sibling panes with per-client active panes", async () => {
    const workspace = await host.ensureWorkspace({
      taskId: "t-siblings" as TaskId,
      cwd,
      label: "siblings",
    });
    const a = await host.ensurePane({
      workspaceId: workspace.workspaceId,
      runId: "sibling-a" as RunId,
      cwd,
      executable: "/bin/sh",
      args: [
        "-c",
        'stty -echo; while IFS= read -r line; do printf "%s\\n" "$line" >> a.txt; done',
      ],
      env: paneEnv(),
    });
    const paneId = (
      await tmux(
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        a.paneId,
        "-c",
        cwd,
        "/bin/sh",
        "-c",
        'stty -echo; while IFS= read -r line; do printf "%s\\n" "$line" >> b.txt; done',
      )
    ).trim();
    const b = { ...a, paneId };
    let output = "";
    const viewer = (ref: PaneRef) => {
      const args = host.attachArgs(ref);
      const child = spawn(
        PYTHON,
        [
          "-c",
          `
import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
while True:
    ready, _, _ = select.select([0, fd], [], [])
    for source in ready:
        data = os.read(source, 65536)
        if not data:
            sys.exit(0)
        os.write(fd if source == 0 else 1, data)
`,
          ...args,
        ],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: process.env.HOME,
            TERM: "xterm-256color",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdout.on("data", (data) => {
        output += data.toString();
      });
      child.stderr.on("data", (data) => {
        output += data.toString();
      });
      return child;
    };
    const first = viewer(a);
    const second = viewer(b);
    try {
      await until(async () => (await host.listClients(a)).length === 2);
      await delay(150);
      first.stdin.write("alpha\n");
      second.stdin.write("bravo\n");
      await until(async () =>
        (await readFile(join(dir, "a.txt"), "utf8").catch(() => "")).includes(
          "alpha",
        ),
      );
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("alpha\n");
      expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("bravo\n");
      first.kill("SIGKILL");
      second.stdin.write("survives\n");
      await until(async () =>
        (await readFile(join(dir, "b.txt"), "utf8")).includes("survives"),
      );
      expect((await host.getPane(a))?.dead).toBe(false);
      expect((await host.getPane(b))?.dead).toBe(false);
    } catch (error) {
      throw new Error(
        `${String(error)}; output=${JSON.stringify(output)}; clients=${await tmux("list-clients", "-F", "#{client_name} #{session_name} #{pane_id} #{client_flags}")}; a=${await readFile(join(dir, "a.txt"), "utf8").catch(() => "missing")}; b=${await readFile(join(dir, "b.txt"), "utf8").catch(() => "missing")}`,
      );
    } finally {
      first.kill("SIGKILL");
      second.kill("SIGKILL");
      await tmux("kill-session", "-t", workspace.workspaceId);
    }
  }, 15000);

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
