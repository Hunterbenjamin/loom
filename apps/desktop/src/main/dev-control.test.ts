import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { devControls, syncSummary } from "./dev-control.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "loom-dev-control-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/dev.sh"), "exit 0\n");
  return { root, appPath: join(root, "apps/desktop") };
}

test("unavailable in packaged apps or without the checkout script, including direct calls", () => {
  const { root, appPath } = checkout();
  try {
    const packaged = devControls(appPath, true, {});
    expect(packaged.available()).toBe(false);
    expect(() => packaged.run("sync")).toThrow("unavailable");
    expect(devControls(appPath, false, {}).available()).toBe(true);
    rmSync(join(root, "scripts/dev.sh"));
    const missing = devControls(appPath, false, {});
    expect(missing.available()).toBe(false);
    expect(() => missing.run("restart-app")).toThrow("unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(["restart", "down", "sync; echo bad", null, {}, 1])(
  "rejects unknown IPC command %j before spawning",
  (raw) => {
    vi.mocked(spawn).mockClear();
    expect(() =>
      devControls("/missing/apps/desktop", false, {}).run(raw),
    ).toThrow();
    expect(spawn).not.toHaveBeenCalled();
  },
);

test.each([
  ["sync", "sync", undefined],
  ["restart-coordinator", "restart coordinator", "dev-custom"],
  ["restart-app", "restart app", "dev"],
])(
  "launches %s detached on only the instance's private server",
  async (command, scriptArgs, instance) => {
    const { root, appPath } = checkout();
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const env = {
      LOOM_INSTANCE: instance,
      LOOM_TMUX_BIN: "/custom/tmux",
      LOOM_DATA_ROOT: "/custom/data",
    };
    try {
      const result = devControls(appPath, false, env).run(command);
      expect(spawn).toHaveBeenLastCalledWith(
        "/custom/tmux",
        [
          "-L",
          `loom-${instance ?? "dev"}`,
          "new-session",
          "-d",
          "-s",
          "dev-control-1234",
          "-c",
          root,
          "-e",
          `LOOM_INSTANCE=${instance ?? "dev"}`,
          "-e",
          "LOOM_DATA_ROOT=/custom/data",
          "-e",
          "LOOM_TMUX_BIN=/custom/tmux",
          `scripts/dev.sh ${scriptArgs}`,
        ],
        { cwd: root, env, detached: true, stdio: "ignore" },
      );
      expect(child.unref).toHaveBeenCalledOnce();
      child.emit("exit", 0);
      await result;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("reports launcher failures without executing a real tmux server", async () => {
  const { root, appPath } = checkout();
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  try {
    const result = devControls(appPath, false, {}).run("sync");
    expect(vi.mocked(spawn).mock.lastCall?.[0]).toBe("tmux");
    child.emit("error", new Error("tmux missing"));
    await expect(result).rejects.toThrow("tmux missing");
    const failed = devControls(appPath, false, {}).run("sync");
    child.emit("exit", 1);
    await expect(failed).rejects.toThrow("launcher exited");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync summaries say whether Loom updated, is current, or could not pull", () => {
  expect(
    syncSummary(
      "update: main abc -> def (2 commit(s))\ncoordinator: stale, restarting\napp: up to date\ndev-control-exit 0\n",
    ),
  ).toEqual({
    title: "Loom updated",
    detail:
      "update: main abc -> def (2 commit(s))\ncoordinator: stale, restarting\napp: up to date",
  });
  expect(
    syncSummary("coordinator: up to date\napp: up to date\ndev-control-exit 0")
      .title,
  ).toBe("Loom is up to date");
  expect(
    syncSummary(
      "update: on feat/x; 3 commit(s) on origin/main are not included (left as is)\ndev-control-exit 0",
    ).title,
  ).toBe("Loom couldn't update to the latest main");
  expect(syncSummary("error: boom\ndev-control-exit 1")).toEqual({
    title: "Update failed",
    detail: "error: boom",
  });
});

test("runAndReport writes the script's output to the report and resolves when it ends", async () => {
  const { root, appPath } = checkout();
  const report = join(root, "sync.log");
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockImplementation((() => {
    setTimeout(() => {
      child.emit("exit", 0);
      writeFileSync(report, "app: up to date\ndev-control-exit 0\n");
    }, 0);
    return child;
  }) as never);
  try {
    const output = await devControls(appPath, false, {}).runAndReport(
      "sync",
      report,
      5,
    );
    expect(output).toContain("dev-control-exit 0");
    const command = vi.mocked(spawn).mock.lastCall?.[1]?.at(-1);
    expect(command).toBe(
      `scripts/dev.sh sync > '${report}' 2>&1; echo "dev-control-exit $?" >> '${report}'`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
