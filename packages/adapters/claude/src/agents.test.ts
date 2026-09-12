import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { isPidAlive, isStaleEntry, parseAgentsOutput } from "./agents.js";

const fixture = readFileSync(
  new URL("./fixtures/agents.json", import.meta.url),
  "utf8",
);

describe("claude agents --json", () => {
  test("parses recorded output", () => {
    expect(parseAgentsOutput(fixture)).toEqual([
      {
        sessionId: "03527ae3-6eda-4a19-9a8f-2f1c7f4c18b1",
        status: "other",
        rawStatus: "blocked",
        kind: "background",
        pid: null,
        cwd: "/Users/example/.loom/worktrees/lead-agent-setup",
      },
      {
        sessionId: "bf14014a-b30f-444a-a4ec-f6d6ba8c7842",
        status: "busy",
        rawStatus: "busy",
        kind: "interactive",
        pid: 61856,
        cwd: "/Users/example/.loom/worktrees/loom/dev-57",
      },
    ]);
  });

  test("parses a background-only response using state", () => {
    expect(
      parseAgentsOutput(
        JSON.stringify([
          {
            sessionId: "background-session",
            cwd: "/background",
            kind: "background",
            state: "blocked",
          },
        ]),
      ),
    ).toEqual([
      {
        sessionId: "background-session",
        status: "other",
        rawStatus: "blocked",
        kind: "background",
        pid: null,
        cwd: "/background",
      },
    ]);
  });

  test.each(["busy", "waiting", "idle"])(
    "keeps the interactive %s status mapping",
    (status) => {
      expect(
        parseAgentsOutput(
          JSON.stringify([
            { sessionId: "s", cwd: "/w", kind: "interactive", status },
          ]),
        )[0]?.status,
      ).toBe(status);
    },
  );

  test("prefers status when both status and state are present", () => {
    expect(
      parseAgentsOutput(
        JSON.stringify([
          {
            sessionId: "s",
            cwd: "/w",
            kind: "background",
            status: "idle",
            state: "blocked",
          },
        ]),
      )[0],
    ).toMatchObject({ status: "idle", rawStatus: "idle" });
  });

  test("an unseen status falls back to other, keeping the raw value", () => {
    const [entry] = parseAgentsOutput(
      JSON.stringify([
        {
          sessionId: "s",
          cwd: "/w",
          kind: "compacting",
          status: "compacting",
        },
      ]),
    );
    expect(entry).toEqual({
      sessionId: "s",
      status: "other",
      rawStatus: "compacting",
      kind: "other",
      pid: null,
      cwd: "/w",
    });
  });

  test("an empty list is a valid answer: no sessions, not an error", () => {
    expect(parseAgentsOutput("[]")).toEqual([]);
  });

  test("malformed entries are omitted without hiding valid siblings", () => {
    expect(
      parseAgentsOutput(
        JSON.stringify([
          { sessionId: "missing-status", cwd: "/w", kind: "interactive" },
          { sessionId: 42, cwd: "/w", kind: "interactive", status: "busy" },
          {
            sessionId: "valid",
            cwd: "/w",
            kind: "interactive",
            status: "waiting",
          },
        ]),
      ),
    ).toEqual([
      {
        sessionId: "valid",
        status: "waiting",
        rawStatus: "waiting",
        kind: "interactive",
        pid: null,
        cwd: "/w",
      },
    ]);
  });

  test("invalid JSON and non-array top-level output are rejected", () => {
    expect(() => parseAgentsOutput('{"agents":[]}')).toThrow();
    expect(() => parseAgentsOutput("not json")).toThrow();
  });
});

describe("stale entry detection", () => {
  test("isPidAlive returns false for null or undefined pids", () => {
    expect(isPidAlive(null)).toBe(false);
    expect(isPidAlive(undefined)).toBe(false);
  });

  test("isPidAlive returns true for the current process", () => {
    const currentPid = process.pid;
    expect(isPidAlive(currentPid)).toBe(true);
  });

  test("isPidAlive returns false for a definitely-dead pid", () => {
    // Use a very high PID that's unlikely to exist
    const deadPid = 999999;
    expect(isPidAlive(deadPid)).toBe(false);
  });

  test("isStaleEntry returns false for null pid (conservative)", () => {
    const entries = parseAgentsOutput(fixture);
    const entry = entries[0];
    if (!entry) throw new Error("Expected at least one entry in fixture");
    expect(isStaleEntry({ ...entry, pid: null } as typeof entry)).toBe(false);
  });

  test("isStaleEntry returns false for alive pid", () => {
    const entries = parseAgentsOutput(fixture);
    const entry = entries[0];
    if (!entry) throw new Error("Expected at least one entry in fixture");
    // Replace pid with current process (definitely alive)
    expect(isStaleEntry({ ...entry, pid: process.pid } as typeof entry)).toBe(
      false,
    );
  });

  test("isStaleEntry returns true for dead pid", () => {
    const entries = parseAgentsOutput(fixture);
    const entry = entries[0];
    if (!entry) throw new Error("Expected at least one entry in fixture");
    // Use a very high PID that's unlikely to exist
    expect(isStaleEntry({ ...entry, pid: 999999 } as typeof entry)).toBe(true);
  });

  test("isStaleEntry uses hook activity for null-pid entries", () => {
    const entries = parseAgentsOutput(fixture);
    const entry = entries[0];
    if (!entry) throw new Error("Expected at least one entry in fixture");
    const nullPidEntry = { ...entry, pid: null } as typeof entry;

    const now = "2026-09-12T13:00:00.000Z";
    const stallAfterMs = 900000; // 15 minutes

    // Recent hook activity: entry is live
    const recentHookTime = "2026-09-12T12:59:00.000Z"; // 1 minute ago
    expect(
      isStaleEntry(nullPidEntry, {
        hookLastEventAt: recentHookTime,
        stallAfterMs,
        now,
      }),
    ).toBe(false);

    // Stale hook activity: entry is stale
    const staleHookTime = "2026-09-12T12:00:00.000Z"; // 1 hour ago
    expect(
      isStaleEntry(nullPidEntry, {
        hookLastEventAt: staleHookTime,
        stallAfterMs,
        now,
      }),
    ).toBe(true);

    // No hook activity but have hook options: entry is live (conservative)
    expect(
      isStaleEntry(nullPidEntry, {
        hookLastEventAt: null,
        stallAfterMs,
        now,
      }),
    ).toBe(false);
  });
});
