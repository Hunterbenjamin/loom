import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loom-launcher-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "stable"));
  const tmux = join(bin, "tmux");
  writeFileSync(
    tmux,
    '#!/bin/bash\ncase "$*" in *loom-desktop:0.0*) echo 910001;; *loom-coordinator:0.0*) echo 920001;; esac\n',
    { mode: 0o755 },
  );
  const log = join(root, "signals");
  writeFileSync(
    join(root, "stable/env"),
    `
export LOOM_INSTANCE=stable
export LOOM_DATA_ROOT='${root}'
export LOOM_BIND=127.0.0.1:47810
export LOOM_RENDERER_PORT=5174
export LOOM_DEBUG_PORT=9223
export LOOM_TMUX_BIN='${tmux}'
ps() {
  if [ "$1" = -axo ] && [ "$2" = pid=,ppid= ]; then
    printf '910001 1\\n910002 910001\\n920001 1\\n920002 920001\\n930001 1\\n930002 930001\\n'
  elif [ "$1" = -p ] && [ "$2" = 910002 ] && [ ! -f '${log}' ]; then
    echo 'Electron.app/Contents/MacOS/Electron'
  fi
}
lsof() { case "$*" in *47810*) echo 920002;; *47811*) echo 930002;; esac; }
kill() { printf '%s\\n' "$*" >> '${log}'; }
git() { return 1; }
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOOM_INSTANCE: "stable",
    LOOM_DATA_ROOT: root,
    SHELL: "/bin/sh",
  };
  delete env.LOOM_MCP_PORT;
  delete env.LOOM_HOOK_PORT;
  return {
    root,
    log,
    env,
    run: (...args: string[]) =>
      execFileSync("bash", [resolve("scripts/dev.sh"), ...args], {
        env,
        encoding: "utf8",
      }),
  };
}

test("status resolves the env file and reports only descendants of the selected instance", () => {
  const f = fixture();
  try {
    const output = f.run("status");
    expect(output).toContain("instance: stable");
    expect(output).toContain("LOOM_MCP_PORT=47811 LOOM_HOOK_PORT=47812");
    expect(output).toContain("LOOM_DEBUG_PORT=9223");
    expect(output).toContain("pid 920002, ws://127.0.0.1:47810");
    expect(output).toContain("app: running");
    expect(output).not.toContain("930002");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("down app signals only this instance's process tree", () => {
  const f = fixture();
  try {
    f.run("down", "app");
    const signals = readFileSync(f.log, "utf8");
    expect(signals).toContain("910002");
    expect(signals).not.toMatch(/92000|93000/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("up refuses another process on the protocol port instead of adopting or killing it", () => {
  const f = fixture();
  try {
    const file = join(f.root, "stable/env");
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}\nlsof() { echo 930002; }\n`,
    );
    expect(() => f.run("up", "coordinator")).toThrow(
      /Port 47810 is in use; set LOOM_BIND/,
    );
    expect(() => readFileSync(f.log)).toThrow();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("up leaves the checkout unchanged without fetching", () => {
  const f = fixture();
  try {
    const file = join(f.root, "stable/env");
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}\ngit() { echo unexpected-git-call > '${f.log}'; return 1; }\n`,
    );
    expect(f.run("up")).toContain("coordinator: already running");
    expect(() => readFileSync(f.log)).toThrow();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
