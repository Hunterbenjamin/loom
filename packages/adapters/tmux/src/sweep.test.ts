// The sweep runs against a throwaway socket directory (`TMUX_TMPDIR`), never the user's.
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  abandonedTestServers,
  sweepTestServers,
  tmuxSocketDirectory,
} from "./sweep.js";

const execFile = promisify(execFileCb);
const TMUX = await execFile("/usr/bin/which", [
  process.env.LOOM_TMUX_BIN ?? "tmux",
]).then(
  ({ stdout }) => stdout.trim(),
  () => "",
);
// macOS pids stop at 99998, so this owner can never be running.
const DEAD_PID = 99999;

it("names only test servers whose owner is gone", () => {
  const names = [
    "default",
    "loom-dev",
    "loom-test-1",
    "loom-test-2",
    "loom-test-3-approval",
    "loom-test-x",
    "loom-test-4.bak",
  ];
  expect(abandonedTestServers(names, (pid) => pid === 1)).toEqual([
    "loom-test-2",
    "loom-test-3-approval",
  ]);
});

it("resolves the socket directory the way tmux does", () => {
  expect(tmuxSocketDirectory({}, 501)).toBe("/tmp/tmux-501");
  expect(tmuxSocketDirectory({ TMUX_TMPDIR: "/private/scratch" }, 7)).toBe(
    "/private/scratch/tmux-7",
  );
});

describe.skipIf(TMUX === "")("sweeping", () => {
  it("kills an abandoned server, drops dead sockets and leaves other servers alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-sweep-"));
    const directory = tmuxSocketDirectory({ TMUX_TMPDIR: root });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const env = { ...process.env, TMUX_TMPDIR: root };
    const abandoned = `loom-test-${DEAD_PID}`;
    const own = `loom-test-${process.pid}`;
    for (const name of [abandoned, own])
      await execFile(
        TMUX,
        ["-L", name, "new-session", "-d", "-s", "hold", "--", "sleep", "60"],
        { env },
      );
    writeFileSync(join(directory, `loom-test-${DEAD_PID}-approval`), "");
    writeFileSync(join(directory, "loom-dev"), "");
    try {
      const swept = await sweepTestServers({ directory, tmux: TMUX });
      expect(swept.sort()).toEqual([abandoned, `${abandoned}-approval`]);
      await expect(
        execFile(TMUX, ["-L", abandoned, "list-sessions"], { env }),
      ).rejects.toThrow();
      expect(existsSync(join(directory, abandoned))).toBe(false);
      expect(existsSync(join(directory, `${abandoned}-approval`))).toBe(false);
      // A running owner keeps its server; other names are never touched.
      const { stdout } = await execFile(TMUX, ["-L", own, "list-sessions"], {
        env,
      });
      expect(stdout).toContain("hold");
      expect(existsSync(join(directory, "loom-dev"))).toBe(true);
    } finally {
      await execFile(TMUX, ["-L", own, "kill-server"], { env }).catch(
        () => undefined,
      );
    }
  });
});
