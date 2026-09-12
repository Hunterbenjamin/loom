// Pure tests: the parsing, chunking and configuration decisions, against recorded tmux output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorktreePath } from "@loom/core";
import { describe, expect, it } from "vitest";
import { baseEnv, withUtf8Locale } from "./cli.js";
import { CONFIG_LINES, configFile, hookCommand } from "./config.js";
import { classifyLine } from "./monitor.js";
import { dedupe, PANE_FORMAT, parsePanes, toObservation } from "./panes.js";
import {
  CHUNK_BYTES,
  chunkByBytes,
  isCommandPrefix,
  normalizeNewlines,
} from "./paste.js";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("pane rows", () => {
  const rows = parsePanes(fixture("list-panes.txt"));

  it("reads every field of the recorded output", () => {
    expect(rows).toHaveLength(6);
    expect(rows[2]).toMatchObject({
      paneId: "%2",
      sessionName: "loom-t-42",
      windowId: "@2",
      pid: 42401,
      command: "node",
      dead: false,
      exitCode: null,
      runId: "run-t-42-implementer-0",
      taskId: "t-42",
      isView: false,
    });
  });

  it("keeps a dead pane's exit status and its start path", () => {
    const dead = rows.find((row) => row.paneId === "%3");
    expect(dead).toMatchObject({ dead: true, exitCode: 7, currentPath: "" });
    expect(dead?.startPath).toContain("/t-42");
  });

  it("drops a line it cannot parse rather than guessing", () => {
    expect(parsePanes("%1nonsense\n")).toEqual([]);
    expect(parsePanes("")).toEqual([]);
  });

  it("prefers the owning session over a grouped view of the same pane", () => {
    const unique = dedupe(rows);
    expect(unique).toHaveLength(4);
    expect(unique.every((row) => !row.isView)).toBe(true);
  });

  it("reports null cwd for a dead pane and never invents provider identity", () => {
    const dead = rows.find((row) => row.paneId === "%3");
    if (!dead) throw new Error("fixture changed");
    const observation = toObservation(
      dead,
      "loom-dev#4242",
      "/real/path" as WorktreePath,
    );
    expect(observation).toEqual({
      ref: {
        hostGeneration: "loom-dev#4242",
        sessionName: "loom-t-42",
        windowId: "@3",
        paneId: "%3",
      },
      cwd: null,
      startCwd: "/real/path",
      pid: 42460,
      command: "",
      dead: true,
      exitCode: 7,
    });
    expect(Object.keys(observation)).not.toContain("state");
  });

  it("asks tmux for exactly the fields it parses", () => {
    expect(PANE_FORMAT.split("")).toHaveLength(12);
    expect(PANE_FORMAT).toContain("#{pane_start_path}");
    expect(PANE_FORMAT).toContain("#{pane_dead_status}");
  });
});

describe("paste", () => {
  it("normalizes CRLF and lone CR to LF before transport", () => {
    // tmux's own paste path turned `\r\n` into `\n\n` in spike 06; normalize first.
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeNewlines("\r\n\r\n")).toBe("\n\n");
  });

  it("bounds chunks in UTF-8 bytes and never splits a code point", () => {
    const text = `${"a".repeat(CHUNK_BYTES - 2)}🌱${"b".repeat(CHUNK_BYTES)}`;
    const chunks = chunkByBytes(text);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks)
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(CHUNK_BYTES);
    // The seedling straddles the byte boundary, so it must have moved to the next chunk whole.
    expect(chunks[0]).not.toContain("🌱");
    expect(chunks[1]?.startsWith("🌱")).toBe(true);
    expect(Buffer.from(chunks.join(""), "utf8")).toEqual(
      Buffer.from(text, "utf8"),
    );
  });

  it("chunks 20 KB into bounded pieces that reassemble exactly", () => {
    const text = "x".repeat(20 * 1024);
    const chunks = chunkByBytes(text);
    expect(chunks.length).toBe(Math.ceil((20 * 1024) / CHUNK_BYTES));
    expect(chunks.join("")).toBe(text);
  });

  it("refuses text a TUI reads as a command, not as a prompt", () => {
    expect(isCommandPrefix("/compact")).toBe(true);
    expect(isCommandPrefix("  !ls")).toBe(true);
    expect(isCommandPrefix("path/to/file is fine")).toBe(false);
  });
});

describe("configuration", () => {
  it("carries every setting spike 06 verified", () => {
    const config = configFile();
    for (const line of CONFIG_LINES) expect(config).toContain(line);
    expect(config).toContain("extended-keys always");
    expect(config).toContain("extended-keys-format csi-u");
    expect(config).toContain("xterm*:extkeys");
    expect(config).toContain("remain-on-exit on");
    expect(config).toContain('update-environment ""');
  });

  it("expands the pane id in run-shell, where tmux actually expands formats", () => {
    const hook = hookCommand("/opt/homebrew/bin/tmux", "loom-dev");
    expect(hook.startsWith("run-shell -b '")).toBe(true);
    expect(hook).toContain("#{pane_id}");
    expect(hook).toContain("-L loom-dev");
    // A subscription only reports changes, so two deaths must not produce the same value.
    expect(hook).toContain("$$");
  });
});

describe("environment", () => {
  it("takes only allowlisted names from the process environment", () => {
    const env = baseEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      CLAUDECODE: "1",
      HERDR_ENV: "1",
      AWS_SECRET_ACCESS_KEY: "nope",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
  });

  it("guarantees a UTF-8 locale, which tmux needs to emit the pane format intact", () => {
    expect(withUtf8Locale({ PATH: "/usr/bin" }).LC_CTYPE).toMatch(/UTF-8/);
    expect(withUtf8Locale({ LANG: "en_US.UTF-8" })).toEqual({
      LANG: "en_US.UTF-8",
    });
  });

  it("reads removal markers back out of show-environment", () => {
    const lines = fixture("show-environment.txt").split("\n").filter(Boolean);
    const removed = lines.filter((line) => line.startsWith("-"));
    const present = lines.filter((line) => !line.startsWith("-"));
    expect(removed).toContain("-CLAUDECODE");
    expect(removed).toContain("-HERDR_ENV");
    expect(present.some((line) => line.startsWith("CLAUDECODE"))).toBe(false);
  });
});

describe("monitor", () => {
  it("treats every notification as a hint and %exit as a lost client", () => {
    const kinds = fixture("control-mode.txt")
      .split("\n")
      .filter(Boolean)
      .map(classifyLine);
    expect(kinds.filter((kind) => kind === "invalidate").length).toBe(4);
    expect(kinds.at(-1)).toBe("exit");
    // Pane output is never a decision, so it is not even a hint.
    expect(classifyLine("%output %4 hello")).toBe("ignore");
  });
});
