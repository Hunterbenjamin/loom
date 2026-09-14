import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { devControls } from "./dev-control.js";

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
